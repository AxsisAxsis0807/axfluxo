import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { newProject } from "../src/domain/video/all-versions";
import { plan, WORK_MS, REST_MS } from "../src/services/local-encoding/plan";
import {
  jobs,
  saveJob,
  read,
  write,
  removeJob,
  type LocalJob,
} from "../src/services/local-encoding/storage";
import { runQueue } from "../src/services/local-encoding/queue";
const ref = {
  libraryId: "local",
  fileId: "source",
  versionId: "source",
  hash: "a".repeat(64),
  kind: "audio" as const,
};
function project() {
  return {
    ...newProject(),
    cover: { ...ref, kind: "image" as const },
    namesText: "First\nSecond",
    document: {
      schemaVersion: 1 as const,
      kind: "all-versions" as const,
      id: "doc",
      revision: 0,
      fnf: { schemaVersion: 1 as const, mode: "fnf" as const, paddingUs: 0 },
      clips: [
        {
          id: "clip",
          source: ref,
          sourceDurationUs: 5_000_000,
          interval: { startUs: 1_000_000, endUs: 5_000_000 },
          markersUs: [3_500_000],
        },
      ],
    },
  };
}
async function job(owner = crypto.randomUUID()) {
  const snapshot = project(),
    j: LocalJob = {
      id: crypto.randomUUID(),
      owner,
      snapshot,
      outputIndex: 0,
      filename: "video.mp4",
      state: "queued",
      next: 0,
      total: plan(snapshot).length,
      activeMs: 0,
      restUntil: 0,
      createdAt: Date.now(),
    };
  await saveJob(j);
  return j;
}
describe("local encoding durable queue", () => {
  it("keeps trimmed source positions, version boundaries and frame count across chunks", () => {
    const pieces = plan(project());
    expect(pieces.map((p) => p.frames)).toEqual([120, 30, 90]);
    expect(pieces.map((p) => p.sourceStartUs)).toEqual([
      1_000_000, 3_000_000, 3_500_000,
    ]);
    expect(pieces.map((p) => p.versionFrame)).toEqual([0, 120, 0]);
    expect(pieces.reduce((n, p) => n + p.frames, 0)).toBe(240);
  });
  it("rests at a committed boundary after ten processing minutes then finishes in order", async () => {
    const j = await job(),
      second = { ...j, id: crypto.randomUUID(), createdAt: j.createdAt + 1 };
    await saveJob(second);
    const seen: string[] = [],
      rests: number[] = [],
      stop = new AbortController();
    let elapsed = 0;
    const engine = {
      chunk: async (v: LocalJob) => {
        seen.push(`${v.id}:${v.next}`);
        elapsed += WORK_MS;
        return new Blob(["chunk"]);
      },
      finish: async () => new Blob(["MP4"]),
      dispose: () => {},
    };
    await runQueue(
      j.owner,
      engine,
      stop.signal,
      () => {},
      () => elapsed,
      async (deadline) => {
        rests.push(deadline);
        expect(deadline - Date.now()).toBeGreaterThan(REST_MS - 1000);
        elapsed = 0;
      },
    );
    expect(rests).toHaveLength(6);
    expect(seen).toEqual(
      [0, 1, 2]
        .map((i) => `${j.id}:${i}`)
        .concat([0, 1, 2].map((i) => `${second.id}:${i}`)),
    );
    expect((await jobs(j.owner)).map((j) => j.state)).toEqual([
      "completed",
      "completed",
    ]);
  });
  it("discards an interrupted chunk and resumes only from the last durable cursor", async () => {
    const j = await job(),
      stop = new AbortController();
    let calls = 0;
    const engine = {
      chunk: async () => {
        calls++;
        if (calls === 2) stop.abort();
        return new Blob(["chunk"]);
      },
      finish: async () => new Blob(["MP4"]),
      dispose: () => {},
    };
    await runQueue(j.owner, engine, stop.signal, () => {});
    expect((await jobs(j.owner))[0]).toMatchObject({
      state: "paused",
      next: 1,
    });
    expect(await read(j.owner, `part:${j.id}:0`)).toBeDefined();
    expect(await read(j.owner, `part:${j.id}:1`)).toBeUndefined();
    const resumed: number[] = [];
    await runQueue(
      j.owner,
      {
        ...engine,
        chunk: async (v) => {
          resumed.push(v.next);
          return new Blob(["chunk"]);
        },
      },
      new AbortController().signal,
      () => {},
    );
    expect(resumed).toEqual([1, 2]);
    expect((await jobs(j.owner))[0].state).toBe("completed");
  });
  it("isolates owners and removes only the selected job checkpoints and output", async () => {
    const a = await job(),
      b = await job(a.owner);
    await write(a.owner, `part:${a.id}:0`, new Blob(["one"]));
    await write(a.owner, `output:${a.id}`, new Blob(["mp4"]));
    expect(await jobs("other-owner")).toEqual([]);
    await removeJob(a.owner, a.id);
    expect((await jobs(a.owner)).map((j) => j.id)).toEqual([b.id]);
    expect(await read(a.owner, `part:${a.id}:0`)).toBeUndefined();
    expect(await read(a.owner, `output:${a.id}`)).toBeUndefined();
  });
  it("keeps already committed chunks on an encoding failure", async () => {
    const j = await job();
    let calls = 0;
    await expect(
      runQueue(
        j.owner,
        {
          chunk: async () => {
            if (++calls === 2) throw Error("memory");
            return new Blob(["chunk"]);
          },
          finish: async () => new Blob(),
          dispose: () => {},
        },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("memory");
    expect((await jobs(j.owner))[0]).toMatchObject({
      state: "failed",
      next: 1,
      error: "memory",
    });
  });
});
