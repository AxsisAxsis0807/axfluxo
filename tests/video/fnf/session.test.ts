import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { FnfSession } from "../../../src/services/video/fnf-session";
import {
  fnfFilenames,
  defaultFnfPreferences,
  fnfShowcaseSnapshotSchema,
  persistentFnfPreferences,
} from "../../../src/domain/video/fnf-showcase";
import { fnfSnapshotSchema } from "../../../src/domain/video/schema";
import { filenameSchema } from "../../../src/domain/cloud-library/schema";
import {
  saveFnfPreferences,
  loadFnfPreferences,
} from "../../../src/services/developer-storage/fnf-preferences";
import { openDeveloperDB } from "../../../src/services/developer/db";
const source = {
  reference: {
    libraryId: "cloud",
    fileId: "f",
    versionId: "v",
    hash: "a".repeat(64),
    kind: "video" as const,
  },
  durationUs: 90_000_000,
  width: 1920,
  height: 1080,
  geometryVerified: true,
};
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());
it("starts with full length and adds 30 seconds from current position or remaining tail", () => {
  const s = new FnfSession(source);
  expect(s.ranges[0]).toMatchObject({ startUs: 0, endUs: 90_000_000 });
  s.addAt(10_000_000);
  expect(s.ranges[1].endUs).toBe(40_000_000);
  s.addAt(85_000_000);
  expect(s.ranges[2].endUs).toBe(90_000_000);
  expect(() => s.addAt(90_000_000)).toThrow();
});
it("overlaps remain independent; whole moves preserve duration and ties use creation order", () => {
  const s = new FnfSession(source),
    first = s.ranges[0];
  s.edit(first.id, 10_000_000, 20_000_000);
  const second = s.addAt(0);
  s.move(first.id, 0);
  s.name(first.id, "同名");
  s.name(second.id, "同名");
  expect(s.ranges[0].endUs - s.ranges[0].startUs).toBe(10_000_000);
  expect(s.sorted().map((r) => r.id)).toEqual([first.id, second.id]);
  const snapshot = s.snapshot(defaultFnfPreferences());
  expect(snapshot.names).toEqual(["同名.mp4", "同名 (2).mp4"]);
  expect(fnfShowcaseSnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(fnfSnapshotSchema.safeParse(snapshot).success).toBe(false);
  s.move(second.id, 89_000_000);
  expect(s.ranges[1].endUs).toBe(90_000_000);
  expect(s.ranges[1].endUs - s.ranges[1].startUs).toBe(30_000_000);
  s.remove(first.id);
  expect(s.ranges).toHaveLength(1);
});
it("safe filenames retain Japanese, avoid reserved/traversal/control/bidi/long names and never collide", () => {
  const names = [
    "日本語",
    "日本語",
    "../CON",
    "CON",
    "con",
    "a/b",
    "a\\b",
    "same",
    "SAME",
    "same (2)",
    "bad\u0000\u202etext",
    "長".repeat(500),
    "...",
  ];
  const files = fnfFilenames(names);
  expect(new Set(files.map((f) => f.toLowerCase())).size).toBe(files.length);
  for (const f of files) {
    expect(filenameSchema.safeParse(f).success).toBe(true);
    expect(new TextEncoder().encode(f).length).toBeLessThanOrEqual(240);
    expect(f).not.toMatch(/[\u0000\u202e/\\]/);
  }
  expect(files[0]).toBe("日本語.mp4");
  expect(names[2]).toBe("../CON");
});
it("submitted snapshot freezes independent names and order without mutating the session", () => {
  const s = new FnfSession(source);
  const a = s.ranges[0];
  s.name(a.id, "original");
  const snapshot = s.snapshot(defaultFnfPreferences());
  s.name(a.id, "later");
  expect(snapshot.chartNames).toEqual(["original"]);
  expect(s.ranges[0].name).toBe("later");
  const next = new FnfSession(source);
  expect(next.ranges).toHaveLength(1);
  expect(next.ranges[0].name).toBe("");
});
it("only template and username enter persistent stores, never drafts/source/chart names", async () => {
  const s = new FnfSession(source);
  s.name(s.ranges[0].id, "DO_NOT_PERSIST_CHART");
  const preferences = defaultFnfPreferences();
  const polluted = Object.assign(
    { ...preferences },
    { ranges: s.ranges, source, chartNames: ["DO_NOT_PERSIST_CHART"] },
  );
  expect(Object.keys(persistentFnfPreferences(polluted)).sort()).toEqual([
    "schemaVersion",
    "template",
    "username",
  ]);
  await saveFnfPreferences("owner", polluted);
  expect(await loadFnfPreferences("owner")).toEqual(preferences);
  const db = await openDeveloperDB();
  for (const name of Array.from(db.objectStoreNames)) {
    const rows = await new Promise<unknown[]>((resolve) => {
      const q = db.transaction(name).objectStore(name).getAll();
      q.onsuccess = () => resolve(q.result);
    });
    expect(JSON.stringify(rows)).not.toContain("DO_NOT_PERSIST_CHART");
    expect(JSON.stringify(rows)).not.toContain("sourceDurationUs");
    expect(JSON.stringify(rows)).not.toContain("creationOrder");
  }
  db.close();
});
it("rejects empty names, zero frames, forged output names and unstable equal-start order", () => {
  const s = new FnfSession(source);
  expect(() => s.snapshot(defaultFnfPreferences())).toThrow();
  s.name(s.ranges[0].id, "One");
  const second = s.addAt(0);
  s.name(second.id, "Two");
  const snapshot = s.snapshot(defaultFnfPreferences());
  expect(
    fnfShowcaseSnapshotSchema.safeParse({
      ...snapshot,
      names: ["evil.mp4", "Two.mp4"],
    }).success,
  ).toBe(false);
  expect(
    fnfShowcaseSnapshotSchema.safeParse({ ...snapshot, creationOrders: [1, 0] })
      .success,
  ).toBe(false);
  expect(() => s.edit(second.id, 0, 1)).toThrow();
});
