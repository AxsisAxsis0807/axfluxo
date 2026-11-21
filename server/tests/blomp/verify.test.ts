import { Readable } from "node:stream";
import { expect, it, vi, afterEach } from "vitest";
import { blompStorage } from "../../storage/blomp";
import { verifyBlomp, verifyBoundedObject } from "../../storage/blomp-verify";
import type { ProbeRequest } from "../../storage/blomp-compatibility-transport";
import { blompConfiguration } from "../../storage/blomp-config";
const env = {
  BLOMP_ENABLED: "true",
  BLOMP_BUCKET: "dummy",
  BLOMP_ACCESS_KEY_ID: "dummy",
  BLOMP_SECRET_ACCESS_KEY: "dummy",
};
const args = ["--approved-connect", "--approved-delete-test"];
it.each(["success", "oversized", "stream-overrun", "billing"])(
  "bounds the native SDK transport on %s",
  async (mode) => {
    let saved = Buffer.alloc(0);
    const requests: ProbeRequest[] = [];
    const report = vi.fn();
    const recordKey = vi.fn();
    const bucket = "diagnostic@example.invalid";
    const handle = async (request: ProbeRequest) => {
      requests.push(request);
      const path = decodeURIComponent(request.path);
      expect(recordKey).toHaveBeenCalledExactlyOnceWith(
        path.slice(`/${bucket}/`.length),
      );
      expect(request.protocol).toBe("https:");
      expect(request.hostname).toBe("storage.blomp.com");
      expect(path).toMatch(
        /^\/diagnostic@example\.invalid\/axfluxo\/99_接続テスト\/[0-9a-f-]{36}\/probe\.bin$/,
      );
      if (request.method === "PUT") {
        expect(request.headers.host).toBe("storage.blomp.com");
        expect(request.headers.authorization).toMatch(
          /^AWS4-HMAC-SHA256 Credential=dummy\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=[^,]*\bhost\b[^,]*, Signature=[a-f0-9]{64}$/,
        );
        expect(request.query).not.toHaveProperty("uploadId");
      }
      let statusCode = 200;
      let body = Buffer.alloc(0);
      let length = 0;
      if (request.method === "PUT") saved = Buffer.from(request.body);
      if (request.method === "GET") {
        if (mode === "billing") statusCode = 402;
        else
          body =
            mode === "stream-overrun"
              ? Buffer.concat([saved, Buffer.from([0])])
              : saved;
        length =
          mode === "oversized"
            ? saved.length + 1
            : mode === "stream-overrun"
              ? saved.length
              : body.length;
      }
      if (request.method === "HEAD") {
        length = saved.length;
        if (!length) statusCode = 404;
      }
      if (request.method === "DELETE") {
        saved = Buffer.alloc(0);
        statusCode = 204;
      }
      return {
        response: {
          statusCode,
          headers: { "content-length": String(length) },
          body: Readable.from([body]),
        },
      };
    };
    const run = verifyBoundedObject(
      blompConfiguration({ ...env, BLOMP_BUCKET: bucket })!,
      1024,
      report,
      { handle, destroy() {} },
      recordKey,
    );
    if (mode === "success") {
      await run;
      expect(report).toHaveBeenCalledWith(
        "HTTP requests: 6; upload bytes reserved: 1024; response body bytes accepted: 2048",
      );
      expect(report).toHaveBeenCalledWith("post-deletion HEAD absence: PASS");
      expect(report).toHaveBeenCalledWith("PUT response: HTTP 200");
      expect(report).toHaveBeenCalledWith("HEAD response: HTTP 404");
    } else {
      await expect(run).rejects.toThrow("BLOMP_VERIFICATION_FAILED");
      expect(report).toHaveBeenCalledWith(
        mode === "billing"
          ? "probe failed: PROBE_PAYMENT_REQUIRED (HTTP 402)"
          : mode === "stream-overrun"
            ? "probe failed: RESPONSE_BUDGET_EXCEEDED"
            : "probe failed: UNSAFE_RESPONSE (HTTP 200)",
      );
    }
    expect(new Set(requests.map((r) => r.path)).size).toBe(1);
    expect(requests.map((r) => r.method)).toEqual(
      mode === "success"
        ? ["PUT", "HEAD", "GET", "GET", "DELETE", "HEAD"]
        : ["PUT", "HEAD", "GET"],
    );
  },
);

it.each([
  [401, "application/xml", "PROBE_AUTH_REQUIRED"],
  [403, "application/xml", "PROBE_ACCESS_DENIED"],
  [429, "application/xml", "PROBE_RATE_LIMITED"],
  [307, "application/xml", "PROBE_REDIRECT_BLOCKED"],
  [200, "text/html; charset=utf-8", "PROBE_HTML_RESPONSE"],
  [202, "application/xml", "PROBE_PUT_NOT_CONFIRMED"],
  [500, "application/xml", "PROBE_PUT_NOT_CONFIRMED"],
] as const)(
  "distinguishes PUT response %s without exposing response data",
  async (statusCode, contentType, code) => {
    const report = vi.fn();
    const handle = vi.fn(async () => ({
      response: {
        statusCode,
        headers: {
          "content-type": contentType,
          location: "https://secret.invalid",
        },
        body: Readable.from(["secret response"]),
      },
    }));
    await expect(
      verifyBoundedObject(blompConfiguration(env)!, 1_000_000, report, {
        handle,
        destroy() {},
      }),
    ).rejects.toThrow("BLOMP_VERIFICATION_FAILED");
    expect(handle).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      `probe failed: ${code} (HTTP ${statusCode})`,
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain("secret");
  },
);

it.each([
  [{ name: "TimeoutError" }, "PROBE_TIMEOUT"],
  [{ code: "ECONNRESET" }, "PROBE_NETWORK_FAILURE"],
  [
    { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } },
    "PROBE_SDK_BUCKET_NOT_FOUND (HTTP 404)",
  ],
])(
  "classifies a failed PUT without logging its raw error",
  async (details, expected) => {
    const handle = vi.fn(async () => {
      throw Object.assign(new Error("secret details"), details);
    });
    const report = vi.fn();
    await expect(
      verifyBoundedObject(blompConfiguration(env)!, 1, report, {
        handle,
        destroy() {},
      }),
    ).rejects.toThrow("BLOMP_VERIFICATION_FAILED");
    expect(handle).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(`probe failed: ${expected}`);
    expect(JSON.stringify(report.mock.calls)).not.toContain("secret details");
  },
);

it("fails closed before transport when the test key cannot be recorded", async () => {
  const handle = vi.fn();
  await expect(
    verifyBoundedObject(
      blompConfiguration(env)!,
      1,
      vi.fn(),
      { handle, destroy() {} },
      () => {
        throw new Error("record failure");
      },
    ),
  ).rejects.toThrow("record failure");
  expect(handle).not.toHaveBeenCalled();
});
afterEach(() => vi.unstubAllGlobals());
function fixture(
  mode?:
    | "hash"
    | "lost-put"
    | "cleanup"
    | "signed-expired"
    | "signed-hash"
    | "dual-failure"
    | "still-present",
) {
  const storage = blompStorage(blompConfiguration(env)!);
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(),
    deleted = false;
  const put = vi
    .spyOn(storage, "putTest")
    .mockImplementation(async (_ref, input) => {
      bytes = input;
      if (mode === "lost-put" || mode === "dual-failure")
        throw Error("secret lost response");
    });
  vi.spyOn(storage, "head").mockImplementation(async () =>
    deleted ? null : { size: bytes.length, etag: undefined },
  );
  vi.spyOn(storage, "stream").mockImplementation(async () =>
    Readable.from([mode === "hash" ? new Uint8Array(bytes.length) : bytes]),
  );
  vi.spyOn(storage, "sign").mockResolvedValue({
    url: "https://dummy.invalid/private-signed-url",
    expiresAt: Date.now() + 60000,
  });
  const remove = vi
    .spyOn(storage, "deleteTest")
    .mockImplementation(async () => {
      if (mode === "cleanup" || mode === "dual-failure")
        throw Error("secret cleanup error");
      deleted = mode !== "still-present";
    });
  const close = vi.spyOn(storage, "close");
  const fetcher = vi.fn(async () =>
    mode === "signed-expired"
      ? new Response(null, { status: 403 })
      : new Response(
          mode === "signed-hash"
            ? new Uint8Array(bytes.length)
            : new Uint8Array(bytes),
        ),
  );
  vi.stubGlobal("fetch", fetcher);
  const factory = vi.fn(() => storage),
    report = vi.fn();
  return { storage, factory, report, remove, close, put, fetcher };
}
it("complete explicit verifier, exact 1024-byte hash and same generated key cleanup", async () => {
  const f = fixture();
  await verifyBlomp(env, args, f.report, f.factory);
  expect(f.put).toHaveBeenCalledOnce();
  expect(f.remove).toHaveBeenCalledWith(f.put.mock.calls[0][0]);
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.report).toHaveBeenCalledWith("download SHA-256: PASS");
  expect(f.report).toHaveBeenCalledWith("post-deletion HEAD absence: PASS");
  expect(JSON.stringify(f.report.mock.calls)).not.toContain(
    "private-signed-url",
  );
});
it("verifies and cleans up the same explicit 1 MB test object", async () => {
  const f = fixture();
  await verifyBlomp(
    env,
    [...args, "--test-bytes=1000000"],
    f.report,
    f.factory,
  );
  const [ref, bytes] = f.put.mock.calls[0];
  expect(bytes.length).toBe(1_000_000);
  expect(f.put).toHaveBeenCalledOnce();
  expect(f.remove).toHaveBeenCalledExactlyOnceWith(ref);
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(f.report).toHaveBeenCalledWith("post-deletion HEAD absence: PASS");
});

it.each([
  ["--test-bytes=1000001"],
  ["--test-bytes=0"],
  ["--test-bytes=1e6"],
  ["--test-bytes=1", "--test-bytes=1"],
])("rejects an unsafe size before opening storage", async (...sizeOptions) => {
  const f = fixture();
  await expect(
    verifyBlomp(env, [...args, ...sizeOptions], f.report, f.factory),
  ).rejects.toThrow("BLOMP_SIZE_MISMATCH");
  expect(f.factory).not.toHaveBeenCalled();
});

it("reports probe and cleanup failure separately without retry or raw errors", async () => {
  const f = fixture("dual-failure");
  await expect(verifyBlomp(env, args, f.report, f.factory)).rejects.toThrow(
    "BLOMP_CLEANUP_FAILED",
  );
  expect(f.report).toHaveBeenCalledWith(
    "probe failed: BLOMP_VERIFICATION_FAILED",
  );
  expect(f.report).toHaveBeenCalledWith(
    "test cleanup: FAILED; owner must inspect connection-tests area",
  );
  expect(f.remove).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.report.mock.calls)).not.toContain("secret");
});
it("fails verification when the object remains visible after DELETE", async () => {
  const f = fixture("still-present");
  await expect(verifyBlomp(env, args, f.report, f.factory)).rejects.toThrow(
    "BLOMP_CLEANUP_FAILED",
  );
  expect(f.remove).toHaveBeenCalledOnce();
  expect(f.report).toHaveBeenCalledWith("test object deletion: PASS");
  expect(f.report).not.toHaveBeenCalledWith("post-deletion HEAD absence: PASS");
});
it.each(["hash", "lost-put", "signed-expired", "signed-hash"] as const)(
  "cleans only invocation object after %s failure",
  async (mode) => {
    const f = fixture(mode);
    await expect(verifyBlomp(env, args, f.report, f.factory)).rejects.toThrow();
    expect(f.remove).toHaveBeenCalledWith(f.put.mock.calls[0][0]);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.report).not.toHaveBeenCalledWith(
      "signed GET SHA-256 (server, not browser CORS): PASS",
    );
  },
);
it("cleanup failure is explicit, sanitized and never claims completion", async () => {
  const f = fixture("cleanup");
  await expect(verifyBlomp(env, args, f.report, f.factory)).rejects.toThrow(
    "BLOMP_CLEANUP_FAILED",
  );
  expect(f.report).not.toHaveBeenCalledWith("test object deletion: PASS");
  expect(JSON.stringify(f.report.mock.calls)).not.toContain(
    "secret cleanup error",
  );
  expect(f.close).toHaveBeenCalledOnce();
});
it.each(
  [
    [],
    ["--approved-connect"],
    ["--approved-delete-test"],
    [...args, "extra"],
  ].map((flags) => ({ flags })),
)("no network without both exact opt-ins $flags", async ({ flags }) => {
  const f = fixture();
  await expect(verifyBlomp(env, flags, f.report, f.factory)).rejects.toThrow();
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
  f.storage.close();
});
