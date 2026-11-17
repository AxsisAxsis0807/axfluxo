import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { blompStorage } from "../../storage/blomp";
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
        expect(request.path).toMatch(/^\/dummy\/axfluxo\/connection-tests\//);
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
