import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const state = vi.hoisted(() => ({
  heartbeatError: undefined as unknown,
  failure: vi.fn(async () => true),
  claim: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("../cloud-export/queue", () => ({
  claim: state.claim,
  finishFailure: state.failure,
  publish: state.publish,
  heartbeat: async () => {
    throw state.heartbeatError;
  },
  progress: vi.fn(),
  fenced: vi.fn(),
  findOutputBlob: vi.fn(),
  purgeExpired: vi.fn(),
}));
vi.mock("../cloud-export/storage", () => ({
  blobForOwner: async () => ({
    kind: "image",
    size: 0,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  }),
  readBlob: async function* () {},
  storeBlob: vi.fn(),
}));
import { runExportPass } from "../cloud-export/worker";
import { ExportError } from "../cloud-export/errors";
import type { Database } from "../db/database";
const db = {} as Database;
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it.each([
  ["EXPORT_CANCELLED", "EXPORT_CANCELLED"],
  ["EXPORT_LEASE_LOST", null],
  ["EXPORT_STORAGE_UNAVAILABLE", "EXPORT_STORAGE_UNAVAILABLE"],
  ["EXPORT_DISK_FULL", "EXPORT_DISK_FULL"],
])(
  "keeps heartbeat %s distinct from operator shutdown",
  async (cause, expected) => {
    const dir = await mkdtemp(join(tmpdir(), "export-heartbeat-"));
    state.claim.mockResolvedValue({
      owner: "owner",
      job: "job",
      spec: { clips: [], coverBlobId: "cover" },
    });
    state.heartbeatError = new ExportError(cause as "EXPORT_CANCELLED");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    try {
      const pass = runExportPass(
        db,
        {
          workDirectory: dir,
          minFreeBytes: 0,
          maxWorkBytes: 1024 ** 3,
          segmentFrames: 60,
          sessionTimeoutMs: 60000,
          maxOwnerBytes: 1024 ** 3,
        },
        new AbortController().signal,
        async ({ signal }) => {
          ready();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          signal.throwIfAborted();
          throw Error("unreachable");
        },
      );
      await started;
      await vi.advanceTimersByTimeAsync(15000);
      expect(await pass).toBe(true);
      if (expected)
        expect(state.failure).toHaveBeenCalledWith(
          db,
          expect.anything(),
          expect.objectContaining({ code: expected }),
        );
      else expect(state.failure).not.toHaveBeenCalled();
      expect(state.publish).not.toHaveBeenCalled();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
