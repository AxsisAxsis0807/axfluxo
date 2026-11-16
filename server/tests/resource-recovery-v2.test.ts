// Deterministic orchestration tests. SQL fencing is exercised separately by
// cloud-export.test.ts on the isolated native PostgreSQL engine.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "../db/database";
import type { renderExport } from "../cloud-export/render";
const state = vi.hoisted(() => ({
  claim: vi.fn(),
  failure: vi.fn(),
  publish: vi.fn(),
  heartbeat: vi.fn(),
  find: vi.fn(),
  store: vi.fn(),
  hash: vi.fn(),
  download: vi.fn(),
}));
vi.mock("../cloud-export/queue", () => ({
  claim: state.claim,
  finishFailure: state.failure,
  publish: state.publish,
  heartbeat: state.heartbeat,
  findOutputBlob: state.find,
  progress: vi.fn(),
  fenced: vi.fn(),
  purgeExpired: vi.fn(),
}));
vi.mock("../cloud-export/storage", () => ({
  blobForOwner: async () => ({
    kind: "image",
    size: 0,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  }),
  readBlob: async function* () {
    await state.download();
  },
  storeBlob: state.store,
}));
vi.mock("../cloud-export/render", async (original) => ({
  ...(await original<object>()),
  exportFileHash: state.hash,
}));
import { runExportPass } from "../cloud-export/worker";
import { ExportError } from "../cloud-export/errors";
const db = {} as Database;
const barrier = () => Promise.withResolvers<void>();
let directory: string, sentinel: string;
let stop: AbortController;
let output: Awaited<ReturnType<typeof renderExport>>;
const config = () => ({
  workDirectory: directory,
  minFreeBytes: 0,
  maxWorkBytes: 1024 ** 3,
  segmentFrames: 60,
  sessionTimeoutMs: 60000,
  maxOwnerBytes: 1024 ** 3,
});
const claim = {
  owner: "synthetic-owner",
  job: "synthetic-job",
  token: "7",
  attempts: 1,
  spec: { clips: [], coverBlobId: "synthetic-cover" },
};
const run = (render: typeof renderExport = async () => output) =>
  runExportPass(db, config(), stop.signal, render);
beforeEach(async () => {
  vi.resetAllMocks();
  stop = new AbortController();
  directory = await mkdtemp(join(tmpdir(), "axfluxo-recovery-v2-"));
  sentinel = join(directory, "foreign-checkpoint");
  await writeFile(sentinel, "preserve");
  const path = join(directory, "synthetic-validated.mp4");
  await writeFile(path, "synthetic");
  const validation = {
    schemaVersion: 1,
    width: 1920,
    height: 1080,
    codec: "h264",
    fps: 60,
    frames: 60,
    durationUs: 1000000,
    audioSamples: 48128,
    sha256: "a".repeat(64),
    size: 9,
  };
  output = { ...validation, path, validation };
  state.claim.mockResolvedValue(claim);
  state.find.mockResolvedValue(null);
  state.hash.mockResolvedValue(validation.sha256);
  state.store.mockResolvedValue("synthetic-output");
  state.heartbeat.mockResolvedValue(undefined);
  state.failure.mockResolvedValue(true);
});
afterEach(async () => {
  vi.useRealTimers();
  expect(await readFile(sentinel, "utf8")).toBe("preserve");
  expect(await readFile(output.path, "utf8")).toBe("synthetic");
});
const lost = () =>
  expect(state.failure).toHaveBeenCalledWith(
    db,
    claim,
    expect.objectContaining({ code: "EXPORT_WORKER_LOST" }),
  );

it("01: stop before claim never claims or publishes", async () => {
  stop.abort();
  await expect(run()).rejects.toThrow();
  expect(state.claim).not.toHaveBeenCalled();
  expect(state.publish).not.toHaveBeenCalled();
});
it("02: stop while claim is in flight drains its result and records the acquired attempt", async () => {
  const entered = barrier(),
    release = barrier();
  state.claim.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return claim;
  });
  const rendering = vi.fn(async () => output);
  const pass = run(rendering);
  await entered.promise;
  stop.abort();
  release.resolve();
  expect(await pass).toBe(true);
  lost();
  expect(rendering).not.toHaveBeenCalled();
  expect(state.publish).not.toHaveBeenCalled();
});
it("03: stop at successful claim resolution does not start preparation", async () => {
  state.claim.mockImplementation(async () => {
    stop.abort();
    return claim;
  });
  await run();
  lost();
  expect(state.download).not.toHaveBeenCalled();
  expect(state.publish).not.toHaveBeenCalled();
});
it("04: stop during download prohibits rendering and publication", async () => {
  const entered = barrier(),
    release = barrier();
  state.download.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    stop.signal.throwIfAborted();
  });
  const rendering = vi.fn(async () => output),
    pass = run(rendering);
  await entered.promise;
  stop.abort();
  release.resolve();
  await pass;
  lost();
  expect(rendering).not.toHaveBeenCalled();
  expect(state.publish).not.toHaveBeenCalled();
});
it.each(["05 background", "06 FFmpeg", "07 completed segment"])(
  "%s: a stopped render adapter cannot reach storage or publish",
  async () => {
    const entered = barrier(),
      release = barrier();
    const pass = run(async ({ signal }) => {
      entered.resolve();
      await release.promise;
      signal.throwIfAborted();
      return output;
    });
    await entered.promise;
    stop.abort();
    release.resolve();
    await pass;
    lost();
    expect(state.store).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
  },
);
it("08: stop in output storage drains storage but cannot publish its bytes", async () => {
  const entered = barrier(),
    release = barrier();
  state.store.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return "synthetic-output";
  });
  const pass = run();
  await entered.promise;
  stop.abort();
  release.resolve();
  await pass;
  lost();
  expect(state.publish).not.toHaveBeenCalled();
});
it("09: stop during final hash check prevents publish", async () => {
  const entered = barrier(),
    release = barrier();
  state.hash.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return output.sha256;
  });
  const pass = run();
  await entered.promise;
  stop.abort();
  release.resolve();
  await pass;
  lost();
  expect(state.publish).not.toHaveBeenCalled();
});
it("10: a publish already in flight is awaited once; no second failure transition", async () => {
  const entered = barrier(),
    release = barrier();
  state.publish.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
  });
  const pass = run();
  await entered.promise;
  stop.abort();
  release.resolve();
  expect(await pass).toBe(true);
  expect(state.publish).toHaveBeenCalledTimes(1);
  expect(state.failure).not.toHaveBeenCalled();
});
it("11: shutdown waits for the in-flight heartbeat failure before releasing the attempt", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const entered = barrier(),
    heartbeatEntered = barrier(),
    release = barrier();
  state.heartbeat.mockImplementation(async () => {
    heartbeatEntered.resolve();
    await release.promise;
    throw new ExportError("EXPORT_LEASE_LOST");
  });
  const pass = run(async ({ signal }) => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    signal.throwIfAborted();
    return output;
  });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(15000);
  await heartbeatEntered.promise;
  stop.abort();
  await Promise.resolve();
  expect(state.failure).not.toHaveBeenCalled();
  release.resolve();
  await pass;
  lost();
  expect(state.publish).not.toHaveBeenCalled();
});
// Cases 12–15 need real transaction semantics, not a mocked database. See
// cloud-export.test.ts: expired lease/stale token, cancellation during shutdown,
// the three-attempt ceiling, and delayed writes with the old fencing token.
