import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { blompClient, blompStorage } from "../../storage/blomp";
import type { ProbeRequest } from "../../storage/blomp-compatibility-transport";
import { blompConfiguration } from "../../storage/blomp-config";
it("SDK serialization and deserialization transfers actual small bytes through isolated transport", async () => {
  const config = blompConfiguration({
    BLOMP_ENABLED: "true",
    BLOMP_BUCKET: "dummy",
    BLOMP_ACCESS_KEY_ID: "dummy",
    BLOMP_SECRET_ACCESS_KEY: "dummy",
  })!;
  const bytes = Buffer.from("isolated transport bytes\n");
  const digest = (b: Uint8Array) =>
    createHash("sha256").update(b).digest("hex");
  let uploaded = new Uint8Array(),
    calls = 0;
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 1,
    requestHandler: {
      async handle(request: {
        hostname: string;
        path: string;
        headers: Record<string, string>;
        method: string;
        body?: unknown;
      }) {
        calls++;
        expect(request.hostname).toBe("storage.blomp.com");
        expect(decodeURIComponent(request.path)).toMatch(
          /^\/dummy\/axfluxo\/99_接続テスト\//,
        );
        expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
        if (request.method === "PUT")
          uploaded = request.body as Uint8Array<ArrayBuffer>;
        return {
          response: {
            statusCode: 200,
            headers: {
              "content-length": String(bytes.length),
              "content-type": "application/octet-stream",
            },
            body: Readable.from(request.method === "GET" ? [bytes] : []),
          },
        };
      },
    },
  });
  const storage = blompStorage(config, client),
    ref = storage.newTestReference();
  await storage.putTest(ref, bytes);
  expect(digest(uploaded)).toBe(digest(bytes));
  expect((await storage.head(ref))?.size).toBe(bytes.length);
  const result: Uint8Array[] = [];
  for await (const b of await storage.stream(ref)) result.push(b);
  expect(digest(Buffer.concat(result))).toBe(digest(bytes));
  await storage.deleteTest(ref);
  expect(calls).toBe(4);
  storage.close();
});

it("signs UTF-8 and reserved filename bytes and reads old and new catalog keys", async () => {
  const config = blompConfiguration({
    BLOMP_ENABLED: "true",
    BLOMP_BUCKET: "dummy@example.invalid",
    BLOMP_ACCESS_KEY_ID: "dummy",
    BLOMP_SECRET_ACCESS_KEY: "dummy",
  })!;
  const owner = "12345678-1234-4234-8234-123456789012";
  const project = "87654321-4321-4321-8321-210987654321";
  const paths: string[] = [];
  const client = blompClient(config, {
    async handle(request: ProbeRequest) {
      paths.push(request.path);
      expect(request.headers.host).toBe("storage.blomp.com");
      expect(request.headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 .*\/us-east-1\/s3\/aws4_request/,
      );
      return {
        response: {
          statusCode: 200,
          headers: { "content-length": "1" },
          body: Readable.from(
            request.method === "GET" ? [Buffer.from("x")] : [],
          ),
        },
      };
    },
  });
  const storage = blompStorage(config, client);
  try {
    const ref = storage.newReference(
      "originals",
      owner,
      project,
      " 元画像 #?%🍎.png ",
    );
    const legacy = { ...ref, key: `axfluxo/originals/${owner}/${project}` };
    expect(ref.key.split("/").slice(0, 4)).toEqual([
      "axfluxo",
      "02_元素材",
      owner,
      project,
    ]);
    expect(ref.key.split("/").at(-1)).toBe(" 元画像 #?%🍎.png ");
    expect(
      storage.newReference("originals", owner, project, " 元画像 #?%🍎.png ")
        .key,
    ).not.toBe(ref.key);
    for (const target of [ref, legacy]) {
      expect(await storage.head(target)).toMatchObject({ size: 1 });
      for await (const chunk of await storage.stream(target))
        expect(Buffer.from(chunk).toString()).toBe("x");
      const signed = new URL((await storage.sign(target, "GET")).url);
      expect(decodeURIComponent(signed.pathname)).toBe(
        `/dummy@example.invalid/${target.key}`,
      );
      expect(signed.searchParams.get("X-Amz-Credential")).toMatch(
        /\/us-east-1\/s3\/aws4_request$/,
      );
    }
    expect(paths.map(decodeURIComponent)).toEqual(
      [ref, ref, legacy, legacy].map(
        (target) => `/dummy@example.invalid/${target.key}`,
      ),
    );
    expect(paths[0]).toContain("%23%3F%25");
  } finally {
    storage.close();
  }
});

it("preserves Japanese common prefixes and leaf names in a mock S3 listing", async () => {
  const config = blompConfiguration({
    BLOMP_ENABLED: "true",
    BLOMP_BUCKET: "dummy",
    BLOMP_ACCESS_KEY_ID: "dummy",
    BLOMP_SECRET_ACCESS_KEY: "dummy",
  })!;
  const folder = "axfluxo/02_元素材/";
  const key = folder + "プロジェクト/素材 & 画像.png";
  const client = blompClient(config, {
    async handle(request: ProbeRequest) {
      expect(request.query.prefix).toBe(folder);
      expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
      const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>${folder}</Prefix></CommonPrefixes><Contents><Key>${key.replaceAll("&", "&amp;")}</Key><Size>1</Size></Contents></ListBucketResult>`;
      return {
        response: {
          statusCode: 200,
          headers: { "content-type": "application/xml" },
          body: Readable.from([Buffer.from(xml)]),
        },
      };
    },
  });
  try {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: folder,
        Delimiter: "/",
      }),
    );
    expect(page.CommonPrefixes).toEqual([{ Prefix: folder }]);
    expect(page.Contents?.[0]?.Key).toBe(key);
  } finally {
    client.destroy();
  }
});
