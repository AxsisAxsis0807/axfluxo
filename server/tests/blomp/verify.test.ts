import { Readable } from "node:stream";
import { expect, it, vi, afterEach } from "vitest";
import { blompStorage } from "../../storage/blomp";
import { verifyBlomp } from "../../storage/blomp-verify";
import { blompConfiguration } from "../../storage/blomp-config";
const env = {
  BLOMP_ENABLED: "true",
  BLOMP_BUCKET: "dummy",
  BLOMP_ACCESS_KEY_ID: "dummy",
  BLOMP_SECRET_ACCESS_KEY: "dummy",
};
const args = ["--approved-connect", "--approved-delete-test"];
afterEach(() => vi.unstubAllGlobals());
function fixture(
  mode?: "hash" | "lost-put" | "cleanup" | "signed-expired" | "signed-hash",
) {
  const storage = blompStorage(blompConfiguration(env)!);
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(),
    deleted = false;
  const put = vi
    .spyOn(storage, "putTest")
    .mockImplementation(async (_ref, input) => {
      bytes = input;
      if (mode === "lost-put") throw Error("secret lost response");
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
      if (mode === "cleanup") throw Error("secret cleanup error");
      deleted = true;
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
  expect(JSON.stringify(f.report.mock.calls)).not.toContain(
    "private-signed-url",
  );
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
