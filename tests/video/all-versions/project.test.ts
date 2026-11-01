import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  newProject,
  projectNames,
  projectIssues,
  versionIntervals,
  textAlpha,
} from "../../../src/domain/video/all-versions";
import { allVersionsDocumentSchema } from "../../../src/domain/video/schema";
import {
  ProjectSaveQueue,
  syncProject,
} from "../../../src/services/video/project-sync";
import {
  saveProject,
  localProject,
  syncEntry,
  conflictDrafts,
  acknowledge,
} from "../../../src/services/developer-storage/projects";
function populated() {
  const p = newProject(),
    ref = {
      libraryId: "cloud",
      fileId: "f",
      versionId: "v",
      hash: "a".repeat(64),
      kind: "audio" as const,
    };
  p.cover = { ...ref, kind: "image" };
  p.document = allVersionsDocumentSchema.parse({
    schemaVersion: 1,
    kind: "all-versions",
    id: "doc",
    revision: 0,
    fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
    clips: [
      {
        id: "c1",
        source: ref,
        sourceDurationUs: 4_000_000,
        interval: { startUs: 0, endUs: 2_000_000 },
        markersUs: [1_000_000],
      },
      {
        id: "c2",
        source: ref,
        sourceDurationUs: 4_000_000,
        interval: { startUs: 1_000_000, endUs: 2_000_000 },
        markersUs: [],
      },
    ],
  });
  p.namesText = "1. One\n2) Two\nThree";
  return p;
}
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("retains blank lines and original numbering unless explicitly removed", () => {
  const p = populated();
  expect(projectNames(p)[0]).toBe("1. One");
  p.removeNumbers = true;
  expect(projectNames(p)).toEqual(["One", "Two", "Three"]);
  expect(p.namesText).toContain("1. One");
  p.namesText += "\n";
  expect(projectNames(p)).toHaveLength(4);
  expect(projectIssues(p)).toContain("EMPTY_NAME");
  expect(projectIssues(p)).toContain("NAME_COUNT");
});
it("clip order, markers and cumulative boundaries determine versions; trim never deletes markers/names", () => {
  const p = populated();
  expect(versionIntervals(p).map((v) => [v.startFrame, v.endFrame])).toEqual([
    [0, 60],
    [60, 120],
    [120, 180],
  ]);
  p.document!.clips.reverse();
  expect(versionIntervals(p).map((v) => v.clipIndex)).toEqual([0, 1, 1]);
  const text = p.namesText;
  const invalid = structuredClone(p.document!);
  invalid.clips[1].interval.startUs = 1_100_000;
  expect(allVersionsDocumentSchema.safeParse(invalid).success).toBe(false);
  expect(p.namesText).toBe(text);
  expect(p.document!.clips[1].markersUs).toEqual([1_000_000]);
});
it("detects too-short fade without shortening fade, versions or names; checks boundary frames", () => {
  const p = populated();
  const v = versionIntervals(p)[0];
  expect(textAlpha(-1, v, p.design)).toBe(0);
  expect(textAlpha(0, v, p.design)).toBe(0);
  expect(textAlpha(9, v, p.design)).toBe(1);
  expect(textAlpha(51, v, p.design)).toBe(1);
  expect(textAlpha(59, v, p.design)).toBeCloseTo(1 / 9);
  expect(textAlpha(60, v, p.design)).toBe(0);
  p.design.fadeInFrames = 61;
  expect(projectIssues(p)).toContain("FADE_TOO_LONG");
  expect(p.design.fadeOutFrames).toBe(9);
});
it("does not introduce a version-count or duration limit", () => {
  const p = populated();
  p.document!.clips = [
    {
      ...p.document!.clips[0],
      sourceDurationUs: 360_000_000_000,
      interval: { startUs: 0, endUs: 360_000_000_000 },
      markersUs: Array.from({ length: 5000 }, (_, i) => (i + 1) * 1_000_000),
    },
  ];
  p.namesText = Array.from({ length: 5001 }, (_, i) => `Version ${i + 1}`).join(
    "\n",
  );
  expect(projectIssues(p)).toEqual([]);
  expect(versionIntervals(p)).toHaveLength(5001);
});
it("debounces 750ms, serializes edits and flush is a durable barrier with outbox", async () => {
  const p = populated(),
    q = new ProjectSaveQueue("owner");
  q.schedule(p);
  q.schedule({ ...p, namesText: "changed" });
  expect(await localProject("owner", p.id)).toBeNull();
  await q.flush();
  expect((await localProject("owner", p.id))!.project.namesText).toBe(
    "changed",
  );
  expect((await syncEntry("owner", p.id))!.revision).toBe(1);
  q.schedule({ ...p, namesText: "next" });
  await q.flush();
  expect(q.revision).toBe(2);
  q.dispose();
});
it("two tabs retain the winning revision and losing proposal durably", async () => {
  const p = populated();
  await saveProject("owner", p, 0);
  const losing = { ...p, namesText: "losing" };
  await expect(saveProject("owner", losing, 0)).rejects.toThrow(
    "PROJECT_CONFLICT",
  );
  expect((await localProject("owner", p.id))!.project.namesText).toBe(
    p.namesText,
  );
  expect((await conflictDrafts("owner", p.id))[0].namesText).toBe("losing");
});
it("offline keeps local data/outbox; cloud conflict preserves both and never silently retries overwrite", async () => {
  const p = populated();
  await saveProject("owner", p, 0);
  await expect(
    syncProject("owner", p.id, {
      put: async () => {
        throw new Error("offline");
      },
    }),
  ).rejects.toThrow("offline");
  expect(await syncEntry("owner", p.id)).toBeTruthy();
  const remote = { ...p, namesText: "remote" };
  await expect(
    syncProject("owner", p.id, { put: async () => ({ conflict: remote }) }),
  ).rejects.toThrow("PROJECT_CONFLICT");
  const row = (await localProject("owner", p.id))!;
  expect(row.project.namesText).toBe(p.namesText);
  expect(row.conflict!.namesText).toBe("remote");
});
it("acknowledging an older upload keeps newer edits queued against the new cloud revision", async () => {
  const p = populated();
  await saveProject("owner", p, 0);
  await saveProject("owner", { ...p, namesText: "newer" }, 1);
  await acknowledge("owner", p.id, 1, 7);
  const entry = (await syncEntry("owner", p.id))!;
  expect(entry.project.namesText).toBe("newer");
  expect(entry.expected).toBe(7);
  expect(entry.revision).toBe(2);
});
it("quota failure rolls back document and outbox without claiming saved", async () => {
  const { IDBObjectStore } = await import("fake-indexeddb");
  const spy = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
  const p = populated();
  const q = new ProjectSaveQueue("owner");
  q.schedule(p);
  const result = q.flush();
  await expect(result).rejects.toBeTruthy();
  spy.mockRestore();
  expect(await localProject("owner", p.id)).toBeNull();
  expect(await syncEntry("owner", p.id)).toBeNull();
  q.dispose();
});

it("an older failed save cannot replay over a newer queued edit", async () => {
  const { IDBObjectStore } = await import("fake-indexeddb");
  const original = IDBObjectStore.prototype.put;
  let failed = false;
  const spy = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (
        (value as { project?: { namesText: string } }).project?.namesText ===
          "older" &&
        !failed
      ) {
        failed = true;
        throw new DOMException("quota", "QuotaExceededError");
      }
      return key === undefined
        ? original.call(this, value)
        : original.call(this, value, key);
    });
  const p = populated(),
    q = new ProjectSaveQueue("owner");
  q.schedule({ ...p, namesText: "older" });
  const a = q.flush();
  q.schedule({ ...p, namesText: "newer" });
  const b = q.flush();
  await Promise.allSettled([a, b]);
  await q.flush();
  spy.mockRestore();
  expect((await localProject("owner", p.id))!.project.namesText).toBe("newer");
  expect(q.isSaved).toBe(true);
  q.dispose();
});
