import { Readable } from "node:stream";
import { describe, expect, it, vi, type Mock } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { blompConfiguration, blompLocation } from "../../storage/blomp-config";
import { blompClient, blompStorage } from "../../storage/blomp";
import { cloudConfiguration } from "../../storage/config";
import { verifyBlomp } from "../../storage/blomp-verify";
const env = {
  BLOMP_ENABLED: "true",
  BLOMP_BUCKET: "dummy@example.invalid",
  BLOMP_ACCESS_KEY_ID: "dummy-access",
  BLOMP_SECRET_ACCESS_KEY: "dummy-secret",
};
const config = blompConfiguration(env)!;
const owner = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const client = new S3Client({ region: "us-east-1" });
  const send = vi.spyOn(client, "send") as unknown as Mock<
    (command: { input: Record<string, unknown> }) => Promise<unknown>
  >;
  const storage = blompStorage(config, client);
  return {
    storage,
    send,
    ref: storage.newReference("originals", owner, null, "素材 #%.mp4"),
  };
}
describe("configuration boundaries", () => {
  it("defaults OFF and does not alter R2/admission", () => {
    expect(blompConfiguration({})).toBeNull();
    expect(blompConfiguration({ ...env, BLOMP_ENABLED: "false" })).toBeNull();
    expect(cloudConfiguration(env).storage).toBeNull();
    expect(cloudConfiguration(env).uploadsEnabled()).toBe(false);
  });
  it("pins reassigned account namespaces without changing legacy or rotated references", () => {
    const legacy = blompConfiguration(env)!;
    const binding = "22222222-2222-4222-8222-222222222222";
    const bound = blompConfiguration({
      ...env,
      BLOMP_ACCOUNT_BINDING_ID: binding,
    })!;
    expect(blompLocation(bound)).not.toBe(blompLocation(legacy));
    expect(blompLocation({ ...bound, accessKeyId: "rotated" })).toBe(
      blompLocation(bound),
    );
    const adapter = blompStorage(bound);
    try {
      expect(adapter.location).toBe(blompLocation(bound));
    } finally {
      adapter.close();
    }
    expect(() =>
      blompConfiguration({ ...env, BLOMP_ACCOUNT_BINDING_ID: "invalid" }),
    ).toThrow();
  });
  it.each(["BLOMP_BUCKET", "BLOMP_ACCESS_KEY_ID", "BLOMP_SECRET_ACCESS_KEY"])(
    "requires %s",
    (key) => {
      expect(() => blompConfiguration({ ...env, [key]: "" })).toThrow(
        "Invalid Blomp configuration",
      );
    },
  );
  it.each([
    "http://storage.blomp.com",
    "https://storage.blomp.com.evil.invalid",
    "https://127.0.0.1",
    "https://storage.blomp.com/",
    "https://user:secret@storage.blomp.com",
    "https://storage.blomp.com?x=secret",
    "https://storage.blomp.com:443",
    "https://storage.blomp.com/path",
  ])("rejects endpoint %s", (endpoint) => {
    expect(() =>
      blompConfiguration({ ...env, BLOMP_ENDPOINT: endpoint }),
    ).toThrow("Invalid Blomp configuration");
  });
  it.each(["auto", "us-west-1", "", "us-east-1 "])(
    "rejects region %s",
    (region) => {
      expect(() =>
        blompConfiguration({ ...env, BLOMP_REGION: region }),
      ).toThrow();
    },
  );
  it("rejects ambiguous enabled flag", () =>
    expect(() =>
      blompConfiguration({ ...env, BLOMP_ENABLED: "TRUE" }),
    ).toThrow());
  it("sets SDK path style, fixed region and bounded retries", async () => {
    const client = blompClient(config);
    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.region()).toBe("us-east-1");
    expect(await client.config.maxAttempts()).toBe(1);
    expect(client.config.followRegionRedirects).toBe(false);
    client.destroy();
  });
  it("binds references to physical location but not rotating credentials", () => {
    expect(blompLocation({ ...config, bucket: "other" })).not.toBe(
      blompLocation(config),
    );
    expect(blompLocation({ ...config, secretAccessKey: "rotated" })).toBe(
      blompLocation(config),
    );
  });
});
describe("isolated contract (no provider connection)", () => {
  it("puts and deletes only its own bounded test object", async () => {
    const { storage, send, ref } = fixture();
    send.mockResolvedValue({});
    await expect(storage.deleteTest(ref)).rejects.toThrow("BLOMP_TEST_ONLY");
    const test = storage.newTestReference();
    await storage.putTest(test, new Uint8Array([1, 2, 3]));
    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: config.bucket,
      Key: test.key,
      ContentLength: 3,
    });
    await expect(
      storage.putTest(test, new Uint8Array(65537)),
    ).rejects.toThrow();
    await storage.deleteTest(test);
    await expect(storage.deleteTest(test)).rejects.toThrow("BLOMP_TEST_ONLY");
    const other = blompStorage(config, new S3Client({ region: "us-east-1" }));
    await expect(other.deleteTest(test)).rejects.toThrow("BLOMP_TEST_ONLY");
  });
  it("HEAD and byte streaming including strict Range", async () => {
    const { storage, send, ref } = fixture();
    send.mockResolvedValueOnce({ ContentLength: 3 });
    expect(await storage.head(ref)).toEqual({ size: 3 });
    send.mockResolvedValueOnce({
      Body: Readable.from([Buffer.from("abc")]),
      $metadata: {},
    });
    let text = "";
    for await (const b of await storage.stream(ref)) text += b.toString();
    expect(text).toBe("abc");
    send.mockResolvedValueOnce({
      Body: Readable.from([Buffer.from("b")]),
      ContentRange: "bytes 1-1/3",
      $metadata: { httpStatusCode: 206 },
    });
    text = "";
    for await (const b of await storage.stream(ref, { start: 1, end: 1 }))
      text += b.toString();
    expect(text).toBe("b");
    expect(send.mock.calls.at(-1)![0].input).toMatchObject({
      Range: "bytes=1-1",
    });
    send.mockResolvedValueOnce({
      Body: Readable.from([]),
      $metadata: { httpStatusCode: 200 },
    });
    await expect(storage.stream(ref, { start: 1, end: 1 })).rejects.toThrow(
      "BLOMP_RANGE_UNSUPPORTED",
    );
    await expect(storage.stream(ref, { start: -1, end: 1 })).rejects.toThrow(
      "BLOMP_INVALID_RANGE",
    );
  });
  it("multipart lifecycle, exact-key discovery and pagination", async () => {
    const { storage, send, ref } = fixture();
    send.mockResolvedValueOnce({ UploadId: "upload-1" });
    expect(await storage.create(ref)).toBe("upload-1");
    send.mockResolvedValueOnce({
      Uploads: [
        { Key: ref.key + "evil", UploadId: "bad" },
        { Key: ref.key, UploadId: "upload-1" },
      ],
    });
    expect(await storage.findUploads(ref)).toEqual(["upload-1"]);
    send.mockResolvedValueOnce({
      Parts: [{ PartNumber: 1, ETag: "opaque", Size: 5 * 1024 ** 2 }],
      IsTruncated: true,
      NextPartNumberMarker: "1",
    });
    send.mockResolvedValueOnce({
      Parts: [{ PartNumber: 2, ETag: "opaque2", Size: 1 }],
    });
    const parts = await storage.parts(ref, "upload-1");
    expect(parts).toHaveLength(2);
    send.mockResolvedValue({});
    await storage.complete(ref, "upload-1", parts);
    expect(send.mock.calls.at(-1)![0].input).toMatchObject({
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: "opaque" },
          { PartNumber: 2, ETag: "opaque2" },
        ],
      },
    });
    await storage.abort(ref, "upload-1");
    await expect(
      storage.complete(ref, "upload-1", [...parts].reverse()),
    ).rejects.toThrow();
    await expect(storage.parts(ref, "")).rejects.toThrow();
  });
  it.each([
    "../secret",
    "axfluxo/originals/../outputs/file",
    "https://evil.invalid/file",
    "axfluxo/outputs/%2e%2e/file",
    "originals/file",
    "axfluxo/connection-tests/other/probe.bin",
  ])("rejects key %s before I/O", async (key) => {
    const { storage, send, ref } = fixture();
    await expect(storage.head({ ...ref, key })).rejects.toThrow(
      "BLOMP_INVALID_REFERENCE",
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects provider and location substitution", async () => {
    const { storage, send, ref } = fixture();
    await expect(storage.head({ ...ref, location: "other" })).rejects.toThrow();
    await expect(
      storage.head({ ...ref, provider: "r2" as "blomp" }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    [401, "BLOMP_AUTH_FAILED"],
    [403, "BLOMP_AUTH_FAILED"],
    [429, "BLOMP_RATE_LIMITED"],
    [500, "BLOMP_UNAVAILABLE"],
    [503, "BLOMP_UNAVAILABLE"],
    [507, "BLOMP_CAPACITY_HELD"],
  ])("sanitizes HTTP %s", async (status, code) => {
    const { storage, send, ref } = fixture();
    send.mockRejectedValue({
      message: "dummy-secret signed-url",
      $metadata: { httpStatusCode: status },
    });
    await expect(storage.head(ref)).rejects.toThrow(String(code));
    try {
      await storage.head(ref);
    } catch (e) {
      expect(JSON.stringify(e)).not.toMatch(/dummy-secret|signed-url/);
    }
  });
  it.each([
    ["ExpiredToken", "BLOMP_AUTH_EXPIRED"],
    ["InvalidToken", "BLOMP_AUTH_FAILED"],
    ["AllAccessDisabled", "BLOMP_ACCOUNT_UNAVAILABLE"],
    ["QuotaExceeded", "BLOMP_CAPACITY_HELD"],
  ])(
    "normalizes provider failure %s without exposing its message",
    async (name, code) => {
      const { storage, send, ref } = fixture();
      send.mockRejectedValue({
        name,
        message: "private response",
        $metadata: { httpStatusCode: 403 },
      });
      await expect(storage.head(ref)).rejects.toMatchObject({
        code,
        message: code,
      });
    },
  );
  it("404 is missing, transport timeout and disconnect fail closed", async () => {
    const { storage, send, ref } = fixture();
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    expect(await storage.head(ref)).toBeNull();
    send.mockRejectedValueOnce({ name: "TimeoutError", message: "secret" });
    await expect(storage.head(ref)).rejects.toThrow("BLOMP_TIMEOUT");
    send.mockRejectedValueOnce(new Error("secret connection reset"));
    await expect(storage.head(ref)).rejects.toThrow("BLOMP_UNAVAILABLE");
  });
  it("sanitizes errors after stream consumption begins", async () => {
    const { storage, send, ref } = fixture();
    send.mockResolvedValue({
      Body: Readable.from(
        (async function* () {
          yield Buffer.from("a");
          throw Error("secret");
        })(),
      ),
      $metadata: {},
    });
    await expect(
      (async () => {
        for await (const chunk of await storage.stream(ref)) void chunk;
      })(),
    ).rejects.toThrow("BLOMP_UNAVAILABLE");
  });
  it("generates real SDK SigV4 short-lived path-style signatures without network", async () => {
    const storage = blompStorage(config);
    const ref = storage.newReference("outputs", owner, null, "素材 #%.mp4");
    for (const operation of ["GET", "HEAD", "PART"] as const) {
      const signed = await storage.sign(ref, operation, {
        id: "upload-1",
        number: 1,
        size: 1024,
      });
      const url = new URL(signed.url);
      expect(url.origin).toBe("https://storage.blomp.com");
      expect(decodeURIComponent(url.pathname)).toBe(
        `/${config.bucket}/${ref.key}`,
      );
      expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
      expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
      expect(url.searchParams.get("X-Amz-Credential")).toContain(
        "/us-east-1/s3/aws4_request",
      );
      if (operation === "PART")
        expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
          "content-length",
        );
    }
    storage.close();
  });
  it("live verifier refuses missing approval before factory/network", async () => {
    const factory = vi.fn();
    await expect(verifyBlomp(env, [], vi.fn(), factory)).rejects.toThrow(
      "BLOMP_APPROVAL_REQUIRED",
    );
    expect(factory).not.toHaveBeenCalled();
  });
});
it.each([1, 2, 5])(
  "signs %s GiB metadata without allocating those bytes",
  async (gib) => {
    const storage = blompStorage(config),
      ref = storage.newReference("originals", owner, null, "素材 #%.mp4");
    const result = await storage.sign(ref, "PART", {
      id: "upload",
      number: 1,
      size: gib * 1024 ** 3,
    });
    expect(
      new URL(result.url).searchParams.get("X-Amz-SignedHeaders"),
    ).toContain("content-length");
    storage.close();
  },
);
it("completion response loss is not blindly retried; caller can reconcile using HEAD", async () => {
  const { storage, send, ref } = fixture();
  send.mockRejectedValueOnce(new Error("lost completion response"));
  await expect(
    storage.complete(ref, "upload", [
      { number: 1, size: 1024, etag: "opaque-not-md5" },
    ]),
  ).rejects.toThrow("BLOMP_UNAVAILABLE");
  expect(send).toHaveBeenCalledOnce();
  send.mockResolvedValueOnce({ ContentLength: 1024 });
  expect((await storage.head(ref))?.size).toBe(1024);
  // Size alone is not integrity. Publication remains unavailable in this adapter.
  expect(send).toHaveBeenCalledTimes(2);
});
it.each(["bytes 1-1/invalid", "bytes 1-1/1", "bytes 0-1/3"])(
  "rejects malformed Range response %s",
  async (contentRange) => {
    const { storage, send, ref } = fixture();
    send.mockResolvedValueOnce({
      Body: Readable.from([]),
      ContentRange: contentRange,
      $metadata: { httpStatusCode: 206 },
    });
    await expect(storage.stream(ref, { start: 1, end: 1 })).rejects.toThrow(
      "BLOMP_RANGE_UNSUPPORTED",
    );
  },
);
it("rejects malformed metadata and non-progressing part pagination", async () => {
  const { storage, send, ref } = fixture();
  send.mockResolvedValueOnce({ ContentLength: -1 });
  await expect(storage.head(ref)).rejects.toThrow("BLOMP_INVALID_RESPONSE");
  send.mockResolvedValue({ IsTruncated: true, NextPartNumberMarker: "1" });
  await expect(storage.parts(ref, "upload")).rejects.toThrow(
    "BLOMP_INVALID_RESPONSE",
  );
});
it("rejects trailing-newline bucket and key despite JavaScript dollar-anchor semantics", async () => {
  expect(() => blompConfiguration({ ...env, BLOMP_BUCKET: "dummy\n" })).toThrow(
    "Invalid Blomp configuration",
  );
  const { storage, send, ref } = fixture();
  await expect(storage.head({ ...ref, key: ref.key + "\n" })).rejects.toThrow(
    "BLOMP_INVALID_REFERENCE",
  );
  expect(send).not.toHaveBeenCalled();
});
it("validates direct SDK factory callers as well as environment-driven adapter callers", () => {
  expect(() =>
    blompClient({ ...config, endpoint: "http://storage.blomp.com" }),
  ).toThrow("Invalid Blomp configuration");
  expect(() => blompStorage({ ...config, secretAccessKey: "" })).toThrow(
    "Invalid Blomp configuration",
  );
});
it("rejects test filename wildcard substitution", async () => {
  const { storage, send } = fixture();
  const ref = storage.newTestReference();
  await expect(
    storage.head({ ...ref, key: ref.key.replace("probe.bin", "probeXbin") }),
  ).rejects.toThrow("BLOMP_INVALID_REFERENCE");
  expect(send).not.toHaveBeenCalled();
});

it.each([
  ["inputs", "01_入力素材"],
  ["originals", "02_元素材"],
  ["intermediates", "03_途中データ"],
  ["checkpoints", "04_チェックポイント"],
  ["outputs", "05_完成品"],
] as const)("places %s in the requested Japanese folder", (role, folder) => {
  const { storage } = fixture();
  try {
    const project = "22222222-2222-4222-8222-222222222222";
    const key = storage.newReference(
      role,
      owner,
      project,
      "元ファイル.png",
    ).key;
    const segments = key.split("/");
    expect(segments).toEqual([
      "axfluxo",
      folder,
      owner,
      project,
      expect.stringMatching(/^[a-f0-9-]{36}$/),
      "元ファイル.png",
    ]);
    expect(storage.newTestReference().key.split("/").slice(0, 2)).toEqual([
      "axfluxo",
      "99_接続テスト",
    ]);
  } finally {
    storage.close();
  }
});
