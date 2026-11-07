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
async function records(name: string, keysOnly = false) {
  return new Promise<unknown[]>((resolve, reject) => {
    const req = indexedDB.open("axfluxo.local-video-recovery", 1);
    req.onsuccess = () => {
      const db = req.result;
      const store = db.transaction(name).objectStore(name);
      const read = keysOnly ? store.getAllKeys() : store.getAll();
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
  vi.unstubAllGlobals();
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
  expect(restored?.sources[0].file.name).toBe("source.mp4");
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
    (await records("assets", true)).some((key) =>
      String(key).includes("output:"),
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
it("treats a zero Safari quota estimate as unknown and lets the transaction decide", async () => {
  vi.stubGlobal("navigator", {
    storage: { estimate: async () => ({ quota: 0, usage: 0 }) },
  });
  const s = await store(),
    p = project();
  await expect(s.saveLocalProject(p)).resolves.toBeUndefined();
  expect((await s.loadLocalProject(p.mode))?.id).toBe(p.id);
});
it("stores large files in bounded binary chunks, restores names and rejects corrupt chunks", async () => {
  const s = await store(),
    p = project();
  const bytes = new Uint8Array(4 * 1024 * 1024 + 17).fill(7);
  p.sources[0].file = new File([bytes], "large.mp4", {
    type: "video/mp4",
    lastModified: 1234,
  });
  await s.saveLocalProject(p);
  const restored = await s.loadLocalProject(p.mode);
  expect(restored?.sources[0].file.size).toBe(bytes.length);
  expect(restored?.sources[0].file.name).toBe("large.mp4");
  expect(restored?.sources[0].file.lastModified).toBe(1234);
  const raw = await records("assets");
  expect(raw.some((item) => item instanceof Blob)).toBe(false);
  const chunks = raw.filter(
    (item): item is { bytes: ArrayBuffer; hash: string } =>
      !!item && typeof item === "object" && "bytes" in item,
  );
  expect(chunks.every((item) => item.bytes.byteLength <= 4 * 1024 * 1024)).toBe(
    true,
  );
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open("axfluxo.local-video-recovery", 1);
    req.onsuccess = () => {
      const db = req.result,
        tx = db.transaction("assets", "readwrite"),
        assets = tx.objectStore("assets");
      const key = `chunk:${p.mode}:${p.id}:source:0`,
        get = assets.get(key);
      get.onsuccess = () => {
        const part = get.result as { bytes: ArrayBuffer; hash: string };
        new Uint8Array(part.bytes)[0] ^= 1;
        assets.put(part, key);
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => reject(tx.error);
    };
  });
  await expect(s.loadLocalProject(p.mode)).rejects.toThrow("破損");
});
it("does not publish new settings when saving a later asset chunk fails", async () => {
  const s = await store(),
    p = project();
  await s.saveLocalProject(p);
  const next = {
    ...p,
    names: "unsaved",
    sources: [
      {
        ...p.sources[0],
        id: "replacement",
        file: new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.mp4"),
      },
    ],
  };
  const original = IDBObjectStore.prototype.put;
  const spy = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (this.name === "assets" && String(args[1]).endsWith(":replacement:1"))
        throw new DOMException("chunk full", "QuotaExceededError");
      return original.apply(this, args);
    });
  await expect(s.saveLocalProject(next)).rejects.toThrow("chunk full");
  spy.mockRestore();
  const restored = await s.loadLocalProject(p.mode);
  expect(restored?.names).toBe("one");
  expect(await restored?.sources[0].file.text()).toBe("media");
});
it("round-trips boundary suggestions, manual deletions and selected edits without rewriting media", async () => {
  const s = await store();
  const p = project("all-versions");
  const { sourceKey, DEFAULT_BOUNDARY_SETTINGS, BOUNDARY_ALGORITHM } =
    await import("../../src/services/video/track-boundaries");
  p.sources[0].markers = "1";
  p.sources[0].timeline = {
    currentUs: 1e6,
    zoom: 160,
    gain: 1,
    selected: "",
    editing: true,
    selectedBoundary: "marker:0",
    snapEnabled: false,
    boundaryPlacement: "end",
    detection: {
      sourceKey: sourceKey(p.sources[0].file),
      algorithm: BOUNDARY_ALGORITHM,
      complete: true,
      settings: DEFAULT_BOUNDARY_SETTINGS,
      deleted: ["silence:100:200"],
      candidates: [
        {
          id: "manual",
          startUs: 1e6,
          endUs: 1e6,
          timeUs: 1e6,
          reason: "manual",
          confidence: "low",
        },
      ],
    },
  };
  await s.saveLocalProject(p);
  const restored = await s.loadLocalProject(p.mode);
  expect(restored!.sources[0].timeline).toEqual(p.sources[0].timeline);
  expect(restored!.sources[0].markers).toBe("1");
  expect(sourceKey(restored!.sources[0].file)).toBe(
    p.sources[0].timeline.detection!.sourceKey,
  );
  expect(sourceKey(new File(["different"], "other.wav"))).not.toBe(
    p.sources[0].timeline.detection!.sourceKey,
  );
});

it("coalesces rapid edits and restores boundaries, trim, names and timeline state", async () => {
  const s = await store();
  const p = project("all-versions");
  p.sources[0] = { ...p.sources[0], duration: 50, end: 45, start: 2 };
  const pending = Array.from({ length: 50 }, (_, i) =>
    s.saveLocalProject({
      ...p,
      names: `edit ${i}`,
      sources: [
        {
          ...p.sources[0],
          markers: "10,20,30",
          timeline: {
            currentUs: i * 1e6,
            zoom: 800,
            gain: 2,
            editing: true,
            selected: "",
            snapEnabled: false,
          },
        },
      ],
    }),
  );
  expect(new Set(pending).size).toBe(1);
  await Promise.all(pending);
  const restored = await s.loadLocalProject(p.mode);
  expect(restored?.names).toBe("edit 49");
  expect(restored?.sources[0]).toMatchObject({
    start: 2,
    end: 45,
    markers: "10,20,30",
    timeline: { currentUs: 49e6, zoom: 800, editing: true, snapEnabled: false },
  });
  s.releaseProjectUrls(restored!);
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
