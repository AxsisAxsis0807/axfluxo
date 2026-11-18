// Server-only experimental adapter. Deliberately NOT wired to cloudConfiguration/workers.
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  ListMultipartUploadsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { StoredPart } from "./multipart";
import {
  blompConfiguration,
  blompLocation,
  type BlompConfig,
} from "./blomp-config";

export type BlompRef = { provider: "blomp"; location: string; key: string };
export const blompCapabilities = Object.freeze({
  conditionalWrites: "unverified",
  contentMD5: "unverified",
  etagIsMD5: "unverified",
  multipart: "unverified",
  presignedUrls: "unverified",
  cors: "unverified",
  usageApi: "unverified",
});
const uuid =
  "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const keyPattern = new RegExp(
  `^axfluxo/(?:originals|outputs)/${uuid}/${uuid}$|^axfluxo/connection-tests/${uuid}/probe\\.bin$`,
);
function validatedConfig(config: BlompConfig): BlompConfig {
  return blompConfiguration({
    BLOMP_ENABLED: "true",
    BLOMP_ENDPOINT: config.endpoint,
    BLOMP_REGION: config.region,
    BLOMP_BUCKET: config.bucket,
    BLOMP_ACCESS_KEY_ID: config.accessKeyId,
    BLOMP_SECRET_ACCESS_KEY: config.secretAccessKey,
  })!;
}
export function blompClient(config: BlompConfig) {
  config = validatedConfig(config);
  return new S3Client({
    ...config,
    forcePathStyle: true,
    followRegionRedirects: false,
    maxAttempts: 1,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: new NodeHttpHandler({
      // Smithy creates its own HTTPS agent, so Node's global proxy setting is insufficient.
      httpsAgent: { proxyEnv: process.env },
      connectionTimeout: 5000,
      requestTimeout: 30000,
      socketTimeout: 30000,
      throwOnRequestTimeout: true,
    }),
  });
}
export class BlompError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "BlompError";
  }
}
function safeError(error: unknown): BlompError {
  const e = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  const status = e?.$metadata?.httpStatusCode;
  return new BlompError(
    status === 401 || status === 403
      ? "BLOMP_AUTH_FAILED"
      : status === 404
        ? "BLOMP_NOT_FOUND"
        : status === 429
          ? "BLOMP_RATE_LIMITED"
          : status === 507
            ? "BLOMP_CAPACITY_HELD"
            : e?.name === "TimeoutError"
              ? "BLOMP_TIMEOUT"
              : "BLOMP_UNAVAILABLE",
  );
}
/** Trusted server code only; prefix checks are not authorization or physical isolation. */
export function blompStorage(config: BlompConfig, injected?: S3Client) {
  // Validate even direct callers; no accidental SDK default credential chain.
  config = validatedConfig(config);
  const client = injected ?? blompClient(config);
  const location = blompLocation(config);
  const tests = new Set<string>();
  const base = (ref: BlompRef) => {
    if (
      ref.provider !== "blomp" ||
      ref.location !== location ||
      /[\x00-\x20\x7f]/.test(ref.key) ||
      !keyPattern.test(ref.key)
    )
      throw new BlompError("BLOMP_INVALID_REFERENCE");
    return { Bucket: config.bucket, Key: ref.key };
  };
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      throw safeError(error);
    }
  };
  const upload = (id: string) => {
    if (!id || id.length > 2048 || /[\x00-\x20\x7f]/.test(id))
      throw new BlompError("BLOMP_INVALID_UPLOAD");
    return id;
  };
  const number = (n: number) => {
    if (!Number.isInteger(n) || n < 1 || n > 10000)
      throw new BlompError("BLOMP_INVALID_PART");
    return n;
  };
  return {
    location,
    close: () => client.destroy(),
    newReference(role: "originals" | "outputs", owner: string): BlompRef {
      const ref: BlompRef = {
        provider: "blomp",
        location,
        key: `axfluxo/${role}/${owner}/${randomUUID()}`,
      };
      base(ref);
      return ref;
    },
    newTestReference(): BlompRef {
      const ref: BlompRef = {
        provider: "blomp",
        location,
        key: `axfluxo/connection-tests/${randomUUID()}/probe.bin`,
      };
      tests.add(ref.key);
      return ref;
    },
    async putTest(ref: BlompRef, bytes: Uint8Array) {
      const input = base(ref);
      if (!tests.has(ref.key) || bytes.byteLength > 65536)
        throw new BlompError("BLOMP_TEST_ONLY");
      await run(() =>
        client.send(
          new PutObjectCommand({
            ...input,
            Body: bytes,
            ContentLength: bytes.byteLength,
            ContentType: "application/octet-stream",
          }),
        ),
      );
    },
    async deleteTest(ref: BlompRef) {
      const input = base(ref);
      if (!tests.has(ref.key)) throw new BlompError("BLOMP_TEST_ONLY");
      await run(() => client.send(new DeleteObjectCommand(input)));
      tests.delete(ref.key);
    },
    async head(ref: BlompRef) {
      const input = base(ref);
      try {
        const r = await run(() => client.send(new HeadObjectCommand(input)));
        if (!Number.isSafeInteger(r.ContentLength) || r.ContentLength! < 0)
          throw new BlompError("BLOMP_INVALID_RESPONSE");
        return { size: r.ContentLength!, etag: r.ETag };
      } catch (e) {
        if (e instanceof BlompError && e.code === "BLOMP_NOT_FOUND")
          return null;
        throw e;
      }
    },
    async stream(
      ref: BlompRef,
      range?: { start: number; end: number },
      signal?: AbortSignal,
    ): Promise<AsyncIterable<Uint8Array>> {
      const input = base(ref);
      if (
        range &&
        (!Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.end) ||
          range.start < 0 ||
          range.end < range.start)
      )
        throw new BlompError("BLOMP_INVALID_RANGE");
      const r = await run(() =>
        client.send(
          new GetObjectCommand({
            ...input,
            Range: range ? `bytes=${range.start}-${range.end}` : undefined,
          }),
          { abortSignal: signal },
        ),
      );
      if (!(r.Body instanceof Readable))
        throw new BlompError("BLOMP_INVALID_RESPONSE");
      const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        r.ContentRange ?? "",
      );
      if (
        range &&
        (r.$metadata.httpStatusCode !== 206 ||
          !contentRange ||
          Number(contentRange[1]) !== range.start ||
          Number(contentRange[2]) !== range.end ||
          !Number.isSafeInteger(Number(contentRange[3])) ||
          Number(contentRange[3]) <= range.end)
      ) {
        r.Body.destroy();
        throw new BlompError("BLOMP_RANGE_UNSUPPORTED");
      }
      const body = r.Body;
      return (async function* () {
        try {
          for await (const chunk of body) yield chunk;
        } catch (error) {
          throw safeError(error);
        } finally {
          body.destroy();
        }
      })();
    },
    async create(ref: BlompRef) {
      const input = base(ref);
      const r = await run(() =>
        client.send(
          new CreateMultipartUploadCommand({
            ...input,
            ContentType: "application/octet-stream",
          }),
        ),
      );
      if (!r.UploadId) throw new BlompError("BLOMP_INVALID_RESPONSE");
      return r.UploadId;
    },
    async findUploads(ref: BlompRef) {
      const input = base(ref),
        result: string[] = [];
      let KeyMarker: string | undefined, UploadIdMarker: string | undefined;
      for (let page = 0; page < 100; page++) {
        const r = await run(() =>
          client.send(
            new ListMultipartUploadsCommand({
              Bucket: input.Bucket,
              Prefix: input.Key,
              KeyMarker,
              UploadIdMarker,
            }),
          ),
        );
        for (const u of r.Uploads ?? [])
          if (u.Key === input.Key && u.UploadId) result.push(u.UploadId);
        if (!r.IsTruncated) return result;
        if (
          !r.NextKeyMarker ||
          (r.NextKeyMarker === KeyMarker &&
            r.NextUploadIdMarker === UploadIdMarker)
        )
          break;
        KeyMarker = r.NextKeyMarker;
        UploadIdMarker = r.NextUploadIdMarker;
      }
      throw new BlompError("BLOMP_INVALID_RESPONSE");
    },
    async parts(ref: BlompRef, id: string): Promise<StoredPart[]> {
      const input = { ...base(ref), UploadId: upload(id) },
        result: StoredPart[] = [];
      let PartNumberMarker: string | undefined;
      for (let page = 0; page < 100; page++) {
        const r = await run(() =>
          client.send(new ListPartsCommand({ ...input, PartNumberMarker })),
        );
        for (const p of r.Parts ?? []) {
          if (!p.PartNumber || !p.ETag || p.Size === undefined)
            throw new BlompError("BLOMP_INVALID_RESPONSE");
          result.push({ number: p.PartNumber, size: p.Size, etag: p.ETag });
        }
        if (!r.IsTruncated) return result;
        if (
          !r.NextPartNumberMarker ||
          r.NextPartNumberMarker === PartNumberMarker
        )
          break;
        PartNumberMarker = r.NextPartNumberMarker;
      }
      throw new BlompError("BLOMP_INVALID_RESPONSE");
    },
    async complete(ref: BlompRef, id: string, parts: StoredPart[]) {
      const input = { ...base(ref), UploadId: upload(id) };
      if (
        !parts.length ||
        parts.length > 10000 ||
        parts.some(
          (p, i) =>
            number(p.number) !== i + 1 ||
            !p.etag ||
            !Number.isSafeInteger(p.size) ||
            p.size < 1 ||
            p.size > 5 * 1024 ** 3 ||
            (i < parts.length - 1 && p.size < 5 * 1024 ** 2),
        )
      )
        throw new BlompError("BLOMP_INVALID_PART");
      await run(() =>
        client.send(
          new CompleteMultipartUploadCommand({
            ...input,
            MultipartUpload: {
              Parts: parts.map((p) => ({ PartNumber: p.number, ETag: p.etag })),
            },
          }),
        ),
      );
    },
    async abort(ref: BlompRef, id: string) {
      const input = { ...base(ref), UploadId: upload(id) };
      await run(() => client.send(new AbortMultipartUploadCommand(input)));
    },
    async sign(
      ref: BlompRef,
      operation: "GET" | "HEAD" | "PART",
      part?: { id: string; number: number; size: number },
    ) {
      const input = base(ref);
      const options = {
        expiresIn: 60,
        signableHeaders: new Set(["content-length"]),
      };
      let signing: () => Promise<string>;
      if (operation === "GET")
        signing = () =>
          getSignedUrl(client, new GetObjectCommand(input), options);
      else if (operation === "HEAD")
        signing = () =>
          getSignedUrl(client, new HeadObjectCommand(input), options);
      else if (
        operation === "PART" &&
        part &&
        Number.isSafeInteger(part.size) &&
        part.size > 0 &&
        part.size <= 5 * 1024 ** 3
      ) {
        const command = new UploadPartCommand({
          ...input,
          UploadId: upload(part.id),
          PartNumber: number(part.number),
          ContentLength: part.size,
        });
        signing = () => getSignedUrl(client, command, options);
      } else throw new BlompError("BLOMP_INVALID_OPERATION");
      const url = await run(signing);
      return { url, expiresAt: Date.now() + 60000 };
    },
  };
}
export type BlompStorage = ReturnType<typeof blompStorage>;
