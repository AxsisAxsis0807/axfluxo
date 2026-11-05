import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { ExportQueue } from "../../src/services/video/export-queue";
import type { LocalProjectData } from "../../src/services/video/local-project";
import type { ExportEntry } from "../../src/services/video/export-queue";
const project = (
  mode: LocalProjectData["mode"] = "fnf-showcase",
  id = crypto.randomUUID(),
): LocalProjectData => ({
  id,
  mode,
  cover: "",
  coverId: "",
  names: "one",
  username: "@tester",
  cropTop: 0,
  cropBottom: 0,
  scaleFactor: 1,
  ranges: [{ id: "range", start: 0, end: 1, name: "chart" }],
  sources: [
    {
      id: "source",
      file: new File(["media"], "source.mp4"),
      url: "blob:old",
      start: 0,
      end: 2,
      duration: 2,
      width: 1920,
      height: 1080,
      markers: "",
    },
  ],
});
async function store() {
  return import("../../src/services/video/recovery-store");
}
async function records(name: string) {
  return new Promise<unknown[]>((resolve, reject) => {
    const req = indexedDB.open("axfluxo.local-video-recovery", 1);
    req.onsuccess = () => {
      const db = req.result;
      const read = db.transaction(name).objectStore(name).getAll();
      read.onsuccess = () => {
        resolve(read.result);
        db.close();
      };
      read.onerror = () => reject(read.error);
    };
  });
}
beforeEach(() => {
  vi.restoreAllMocks();
});
it("automatically restores assets and settings and isolates tools and projects", async () => {
  const s = await store(),
    a = project("all-versions"),
    b = project(),
    c = project("all-versions");
  await s.saveLocalProject(a);
  await s.saveLocalProject(b);
  const restored = await s.loadLocalProject(a.mode);
  expect(restored?.id).toBe(a.id);
  expect(await restored?.sources[0].file.text()).toBe("media");
  expect(restored?.sources[0].url).not.toBe("blob:old");
  expect((await s.loadLocalProject(b.mode))?.id).toBe(b.id);
  await s.saveLocalProject(c);
  expect((await s.loadLocalProject(a.mode))?.id).toBe(c.id);
  expect((await records("projects")).length).toBeGreaterThanOrEqual(3);
});
it("does not rewrite shared input or output blobs on progress; restores queued work and completed output", async () => {
  const s = await store(),
    p = project();
  const input = {
    filename: "chart.mp4",
    width: 10,
    height: 10,
    pieces: [],
    draw: () => {},
    recovery: { project: p, index: 0 },
  };
  const entries: ExportEntry[] = [
    {
      id: "pending",
      filename: "chart.mp4",
      state: "rendering",
      progress: 0.4,
      message: "render",
      rest: false,
      input,
    },
    {
      id: "done",
      filename: "done.mp4",
      state: "completed",
      progress: 1,
      message: "done",
      rest: false,
      recovery: input.recovery,
      result: { filename: "done.mp4", blob: new Blob(["completed"]) },
    },
  ];
  await s.saveExportEntries(entries);
  const put = vi.spyOn(IDBObjectStore.prototype, "put");
  await s.saveExportEntries(entries.map((e) => ({ ...e, progress: 0.6 })));
  expect(
    put.mock.instances.filter(
      (instance) => (instance as IDBObjectStore).name === "assets",
    ),
  ).toHaveLength(0);
  const restored = await s.loadExportEntries();
  expect(restored.map((e) => e.state)).toEqual(["queued", "completed"]);
  expect(restored[0].progress).toBe(0);
  expect(restored[0].input?.pieces[0].file).toBeInstanceOf(Blob);
  expect(await restored[1].result?.blob.text()).toBe("completed");
  const calls: string[] = [];
  const q = new ExportQueue(async (job) => {
    calls.push(job.filename);
    return { filename: job.filename, blob: new Blob(["new"]) };
  });
  q.restore(restored);
  q.resume();
  q.resume();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toHaveLength(1);
});
it("keeps unsaved siblings and other projects, deleting only confirmed output and unreferenced assets", async () => {
  const s = await store(),
    p = project(),
    other = project("all-versions");
  await s.saveLocalProject(p);
  await s.saveLocalProject(other);
  const output = (id: string): ExportEntry => ({
    id,
    filename: id,
    state: "completed",
    progress: 1,
    message: "done",
    rest: false,
    recovery: { project: p, index: 0 },
    result: { filename: id, blob: new Blob([id]) },
  });
  await s.saveExportEntries([output("A"), output("B")]);
  await s.saveExportEntries([output("B")]);
  expect((await s.loadLocalProject(p.mode))?.id).toBe(p.id);
  expect((await s.loadExportEntries()).map((e) => e.id)).toEqual(["B"]);
  await s.saveExportEntries([]);
  expect(await s.loadLocalProject(p.mode)).toBeUndefined();
  expect((await s.loadLocalProject(other.mode))?.id).toBe(other.id);
  expect(
    (await records("assets")).some(
      (value) => value instanceof Blob && value.size === 1,
    ),
  ).toBe(false);
});
it("transaction failure preserves the last durable settings and completed output", async () => {
  const s = await store(),
    p = project();
  await s.saveLocalProject(p);
  const original = IDBObjectStore.prototype.put;
  const spy = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (this.name === "projects")
        throw new DOMException("full", "QuotaExceededError");
      return original.apply(this, args);
    });
  await expect(s.saveLocalProject({ ...p, names: "changed" })).rejects.toThrow(
    "full",
  );
  spy.mockRestore();
  expect((await s.loadLocalProject(p.mode))?.names).toBe("one");
});
it("flushes ordered edits before a remounted editor reads and preserves newer edits on output cleanup", async () => {
  const s = await store(),
    p = project();
  const first = s.saveLocalProject(p);
  const last = s.saveLocalProject({ ...p, names: "new edit" });
  expect((await s.loadLocalProject(p.mode))?.names).toBe("new edit");
  await Promise.all([first, last]);
  const entry: ExportEntry = {
    id: "older-output",
    filename: "old.mp4",
    state: "completed",
    progress: 1,
    message: "done",
    rest: false,
    recovery: { project: p, index: 0 },
    result: { filename: "old.mp4", blob: new Blob(["old"]) },
  };
  await s.saveExportEntries([entry]);
  await s.saveExportEntries([]);
  expect((await s.loadLocalProject(p.mode))?.names).toBe("new edit");
});
it("caps repeated crash recovery and never re-encodes completed artifacts", async () => {
  const s = await store(),
    p = project();
  const input = {
    filename: "loop.mp4",
    width: 10,
    height: 10,
    pieces: [],
    draw: () => {},
    recovery: { project: p, index: 0 },
  };
  await s.saveExportEntries([
    {
      id: "loop",
      filename: "loop.mp4",
      state: "rendering",
      progress: 0.5,
      message: "render",
      rest: false,
      input,
      recoveryAttempts: 3,
    },
  ]);
  const [entry] = await s.loadExportEntries();
  expect(entry.state).toBe("failed");
  expect(entry.error).toContain("3回");
  expect(entry.input).toBeDefined();
});
it("fences a stale writer when another tab owns the lease", async () => {
  const s = await store();
  await s.renewRecoveryLease();
  await new Promise<void>((resolve) => {
    const req = indexedDB.open("axfluxo.local-video-recovery", 1);
    req.onsuccess = () => {
      const db = req.result,
        tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put(
        { owner: "other-tab", until: Date.now() + 30000 },
        "lease",
      );
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
    };
  });
  await expect(s.saveLocalProject(project())).rejects.toThrow("別のタブ");
});
