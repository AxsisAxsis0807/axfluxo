import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { blompClient, blompHttpHandler } from "./blomp";
import type { BlompConfig } from "./blomp-config";
import {
  CompatibilityFailure,
  CompatibilityTransport,
} from "./blomp-compatibility-transport";

const mib = 1024 ** 2;
const size = 9 * mib;
const control = 64 * 1024;
export const blompMultipartPlans = {
  B: {
    key: "axfluxo/99_接続テスト/c6aaeb63-af3f-42d0-b349-3e3000abbe9d/multipart検証.bin",
    byte: 0xa5,
    requests: 8,
  },
  C: {
    key: "axfluxo/99_接続テスト/2f295175-d07c-4536-a639-5168462d69b3/復旧検証.bin",
    byte: 0x5a,
    requests: 9,
  },
} as const;
type Scenario = keyof typeof blompMultipartPlans;
type Checkpoint = { key: string; uploadId?: string; stage: string };

function requireProbe(condition: unknown, code: string): asserts condition {
  if (!condition) throw new CompatibilityFailure(code);
}

export async function probeBlompMultipart({
  config,
  scenario,
  checkpoint,
  restoreCheckpoint,
  report,
  driver = blompHttpHandler(),
}: {
  config: BlompConfig;
  scenario: Scenario;
  checkpoint: (event: Checkpoint) => void;
  restoreCheckpoint?: () => Checkpoint;
  report: (line: string) => void;
  driver?: ConstructorParameters<typeof CompatibilityTransport>[2];
}) {
  const { key, byte, requests: requestLimit } = blompMultipartPlans[scenario];
  checkpoint({ key, stage: "reserved" });
  let requests = 0;
  let uploaded = 0;
  let htmlPart = false;
  const transport = new CompatibilityTransport(config.bucket, new Set([key]), {
    async handle(request, options) {
      requireProbe(requests < requestLimit, "MULTIPART_REQUEST_LIMIT");
      requireProbe(
        ["POST", "PUT", "GET", "HEAD"].includes(request.method),
        "MULTIPART_SCOPE",
      );
      const body = request.body;
      const length =
        typeof body === "string"
          ? Buffer.byteLength(body)
          : (body?.byteLength ?? 0);
      if (request.method === "PUT") {
        requireProbe(uploaded + length <= size, "MULTIPART_UPLOAD_LIMIT");
        uploaded += length;
      } else requireProbe(length <= control, "MULTIPART_CONTROL_LIMIT");
      requests++;
      const { response } = await driver.handle(request, options);
      const status = response.statusCode;
      const type = response.headers["content-type"] ?? "";
      const html = /^(text\/html|application\/xhtml\+xml)\b/i.test(type);
      report(`${request.method} HTTP ${status}${html ? " HTML" : ""}`);
      if (
        response.headers.location ||
        [401, 402, 403, 429].includes(status) ||
        (status >= 300 && status < 400) ||
        (html && request.method !== "PUT")
      ) {
        if (response.body instanceof Readable) response.body.destroy();
        throw new CompatibilityFailure(
          html &&
            status === 200 &&
            request.method === "POST" &&
            Object.hasOwn(request.query, "uploadId")
            ? "MULTIPART_COMPLETE_HTML"
            : "MULTIPART_UNEXPECTED_RESPONSE",
          status,
        );
      }
      if (html && request.method === "PUT" && status === 200) {
        if (response.body instanceof Readable) response.body.destroy();
        htmlPart = true;
        return {
          response: {
            ...response,
            headers: { "content-length": "0" },
            body: Readable.from([]),
          },
        };
      }
      return { response };
    },
    destroy() {
      driver.destroy();
    },
  });
  const client = blompClient(config, transport);
  const object = { Bucket: config.bucket, Key: key };
  try {
    const created = await transport.run(control, false, () =>
      client.send(
        new CreateMultipartUploadCommand({
          ...object,
          ContentType: "application/octet-stream",
        }),
      ),
    );
    requireProbe(
      created.$metadata.httpStatusCode === 200 &&
        created.Key === key &&
        created.Bucket === config.bucket &&
        created.UploadId,
      "MULTIPART_ID_UNCONFIRMED",
    );
    const id = created.UploadId;
    transport.bindUpload(key, id);
    checkpoint({ key, uploadId: id, stage: "created" });
    const list = async (count: number) => {
      const found = await transport.run(control, false, () =>
        client.send(
          new ListPartsCommand({ ...object, UploadId: id, MaxParts: 2 }),
        ),
      );
      requireProbe(
        found.$metadata.httpStatusCode === 200 &&
          found.Key === key &&
          found.Bucket === config.bucket &&
          found.UploadId === id &&
          !found.IsTruncated &&
          found.Parts?.length === count,
        "MULTIPART_LIST_MISMATCH",
      );
      return found.Parts.map((part, index) => {
        requireProbe(
          part.PartNumber === index + 1 &&
            part.Size === (index === 0 ? 8 * mib : mib) &&
            part.ETag,
          "MULTIPART_PART_MISMATCH",
        );
        return { PartNumber: part.PartNumber, ETag: part.ETag };
      });
    };
    const upload = async (number: number, length: number) => {
      const signed = new URL(
        await getSignedUrl(
          client,
          new UploadPartCommand({
            ...object,
            UploadId: id,
            PartNumber: number,
            ContentLength: length,
          }),
          { expiresIn: 60 },
        ),
      );
      requireProbe(
        signed.origin === config.endpoint &&
          !signed.username &&
          !signed.password &&
          !signed.hash &&
          decodeURIComponent(signed.pathname) === `/${config.bucket}/${key}` &&
          signed.searchParams.get("uploadId") === id &&
          signed.searchParams.get("partNumber") === String(number) &&
          signed.searchParams
            .get("X-Amz-SignedHeaders")
            ?.split(";")
            .includes("content-length"),
        "MULTIPART_SIGNATURE_SCOPE",
      );
      const query = Object.fromEntries(signed.searchParams);
      requireProbe(
        Object.keys(query).length === signed.searchParams.size,
        "MULTIPART_SIGNATURE_SCOPE",
      );
      htmlPart = false;
      return transport.run(0, false, async () => {
        const { response } = await transport.handle({
          protocol: "https:",
          hostname: signed.hostname,
          path: signed.pathname,
          method: "PUT",
          query,
          headers: { "content-length": String(length) },
          body: Buffer.alloc(length, byte),
          clone() {
            return this;
          },
        });
        requireProbe(
          response.statusCode === 200 && (htmlPart || response.headers.etag),
          "MULTIPART_PART_UNCONFIRMED",
        );
        return response.headers.etag;
      });
    };
    const tag1 = await upload(1, 8 * mib);
    const [first] = await list(1);
    requireProbe(!tag1 || tag1 === first.ETag, "MULTIPART_ETAG_MISMATCH");
    checkpoint({ key, uploadId: id, stage: "part-1-confirmed" });
    if (scenario === "C") {
      // No writer is in flight. Keep the same upload ID and consult storage again.
      report("PAUSED_AFTER_PART_1");
      const restored = restoreCheckpoint?.();
      requireProbe(
        restored?.key === key &&
          restored.uploadId === id &&
          restored.stage === "part-1-confirmed",
        "MULTIPART_CHECKPOINT_MISMATCH",
      );
      const [resumed] = await list(1);
      requireProbe(resumed.ETag === first.ETag, "MULTIPART_RESUME_MISMATCH");
      checkpoint({ key, uploadId: id, stage: "resumed" });
      report("RESUMED_WITH_EXISTING_PART");
    }
    const tag2 = await upload(2, mib);
    const parts = await list(2);
    requireProbe(
      parts[0].ETag === first.ETag && (!tag2 || parts[1].ETag === tag2),
      "MULTIPART_ETAG_MISMATCH",
    );
    checkpoint({ key, uploadId: id, stage: "complete-attempted" });
    try {
      await transport.run(control, false, () =>
        client.send(
          new CompleteMultipartUploadCommand({
            ...object,
            UploadId: id,
            MultipartUpload: { Parts: parts },
          }),
        ),
      );
    } catch (error) {
      if (
        !(error instanceof CompatibilityFailure) ||
        error.code !== "MULTIPART_COMPLETE_HTML"
      )
        throw error;
      report("COMPLETE_UNCONFIRMED");
    }
    const head = await transport.run(0, false, () =>
      client.send(new HeadObjectCommand(object)),
    );
    requireProbe(
      head.$metadata.httpStatusCode === 200 &&
        head.ContentLength === size &&
        head.ETag,
      "MULTIPART_HEAD_MISMATCH",
    );
    await transport.run(size, false, async () => {
      const result = await client.send(new GetObjectCommand(object));
      requireProbe(
        result.$metadata.httpStatusCode === 200 &&
          result.ContentLength === size &&
          result.Body,
        "MULTIPART_GET_MISMATCH",
      );
      const digest = createHash("sha256");
      let received = 0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        requireProbe(received <= size, "MULTIPART_GET_MISMATCH");
        digest.update(chunk);
      }
      const expected = createHash("sha256");
      const block = Buffer.alloc(mib, byte);
      for (let i = 0; i < 9; i++) expected.update(block);
      requireProbe(
        received === size && digest.digest("hex") === expected.digest("hex"),
        "MULTIPART_SHA256_MISMATCH",
      );
    });
    checkpoint({ key, uploadId: id, stage: "verified" });
    report("MULTIPART_SHA256_MATCH");
  } finally {
    client.destroy();
    report(
      JSON.stringify({
        requests,
        uploaded,
        responseBytes: transport.counters.responseBytes,
      }),
    );
  }
}
