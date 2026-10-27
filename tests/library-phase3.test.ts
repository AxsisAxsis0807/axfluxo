import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  importLibraryImage,
  listFiles,
  listFolders,
  putFolder,
  updateFile,
  versionFor,
  lookupLibrary,
  saveLibraryOutput,
  pinReferences,
} from "../src/services/library/repository";

import { read, openWorkspaceDB } from "../src/services/workspace/db";
import {
  newWorkspace,
  saveWorkspace,
  loadWorkspace,
} from "../src/services/workspace/repository";
import { newNode } from "../src/domain/workflow/schema";
import { createAssetResolver } from "../src/services/workflow/asset-resolver";
import { createRegistry } from "../src/services/workflow/registry";
import { Runner, prepareSnapshot } from "../src/services/workflow/runner";
import { runRepository } from "../src/services/workflow/run-repository";
import { sha256 } from "../src/services/assets";
import {
  backupWorkspace,
  restoreWorkspace,
} from "../src/services/workspace/backup";
import { strToU8, zipSync, unzipSync, strFromU8 } from "fflate";
const bytes = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII=",
    "base64",
  ),
);
const image = () => new File([bytes], "input.png", { type: "image/png" });
const signal = () => new AbortController().signal;
const versions = { rendererVersion: "test", fontVersion: "test" };
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 1;
      naturalHeight = 1;
      src = "";
      decode() {
        return Promise.resolve();
      }
    },
  );
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toBlob: (callback: (b: Blob) => void) =>
        callback(new Blob([bytes], { type: "image/png" })),
    }),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("T12: sequential imports deduplicate identical originals and retain original bytes", async () => {
  const a = await importLibraryImage(image());
  const b = await importLibraryImage(image());
  expect(a).toEqual(b);
  expect(await listFiles()).toHaveLength(1);
  const v = await versionFor((await listFiles())[0]);
  expect(await sha256(v.original)).toBe(await sha256(image()));
  await updateFile(a.fileId, { deleted: true });
  expect(await importLibraryImage(image())).toEqual(a);
  expect((await listFiles())[0].deleted).toBe(false);
});
it("T12: rejects MIME mismatch, corrupt bytes, oversize and cancellation before publication", async () => {
  await expect(
    importLibraryImage(new File([bytes], "bad.txt", { type: "text/plain" })),
  ).rejects.toThrow("MIME");
  await expect(
    importLibraryImage(new File([bytes], "bad.jpg", { type: "image/jpeg" })),
  ).rejects.toThrow("MIME");
  await expect(
    importLibraryImage(new File(["bad"], "bad.png", { type: "image/png" })),
  ).rejects.toThrow();
  await expect(
    importLibraryImage(
      new File([new Uint8Array(20 * 1024 * 1024 + 1)], "big.png"),
    ),
  ).rejects.toThrow();
  const abort = new AbortController();
  abort.abort();
  await expect(
    importLibraryImage(image(), null, abort.signal),
  ).rejects.toThrow();
  expect(await listFiles()).toHaveLength(0);
});
it("T12/T15: quota failure leaves original files and no partial imported version or receipt", async () => {
  const ref = await importLibraryImage(image());
  const original = await lookupLibrary(ref);
  const add = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === "libraryReceipts")
      throw new DOMException("full", "QuotaExceededError");
    return add.apply(this, args);
  });
  const context = {
    signal: signal(),
    snapshot: {} as never,
    nodeId: "save",
    inputs: {
      image: {
        type: "image" as const,
        reference: ref,
        hash: ref.hash,
        mime: "image/png",
        width: 1,
        height: 1,
        size: bytes.length,
      },
    },
    resolver: createAssetResolver(),
    outputs: [],
    saveIdentity: { rootRunId: "root", runId: "run", attemptId: "attempt" },
  };
  await expect(saveLibraryOutput(newNode("save"), context)).rejects.toThrow(
    "空き容量",
  );
  expect(await listFiles()).toHaveLength(1);
  expect(await read("libraryReceipts")).toEqual([]);
  expect(await sha256((await lookupLibrary(ref))!.blob)).toBe(original!.hash);
});
it("T13: folder create/rename/move rejects cycles and missing parents; files rename/move/trash/restore", async () => {
  await putFolder({ id: "a", name: "A", parentId: null });
  await putFolder({ id: "b", name: "B", parentId: "a" });
  await expect(
    putFolder({ id: "a", name: "A", parentId: "b" }),
  ).rejects.toThrow("循環");
  await expect(
    putFolder({ id: "c", name: "C", parentId: "missing" }),
  ).rejects.toThrow();
  await putFolder({ id: "b", name: "renamed", parentId: null });
  expect((await listFolders()).find((f) => f.id === "b")?.name).toBe("renamed");
  const ref = await importLibraryImage(image());
  await updateFile(ref.fileId, { folderId: "b", name: "renamed image" });
  await expect(
    updateFile(ref.fileId, { folderId: "missing" }),
  ).rejects.toThrow();
  await pinReferences("workflow:test", [ref]);
  await updateFile(ref.fileId, { deleted: true });
  expect((await listFiles())[0]).toMatchObject({
    deleted: true,
    folderId: "b",
    name: "renamed image",
  });
  expect((await lookupLibrary(ref))!.hash).toBe(ref.hash);
  expect(await read("libraryReferences")).toHaveLength(1);
  await updateFile(ref.fileId, { deleted: false });
  expect((await listFiles())[0].deleted).toBe(false);
});
async function fixture() {
  const ref = await importLibraryImage(image());
  const source = { ...newNode("source"), id: "a", config: { libraryRef: ref } };
  const save = { ...newNode("save"), id: "b" };
  const graph = {
    ...newWorkspace(),
    nodes: [source, save],
    edges: [
      {
        id: "edge",
        sourceNodeId: "a",
        sourcePortId: "image",
        targetNodeId: "b",
        targetPortId: "image",
      },
    ],
  };
  const registry = createRegistry(saveLibraryOutput),
    resolver = createAssetResolver();
  const snapshot = await prepareSnapshot(
    graph,
    registry,
    resolver,
    versions,
    signal(),
  );
  return { ref, graph, registry, resolver, snapshot };
}
it("T14/T15: fixed shared source, save AssetRef, retry twice without duplication and reuse result in another workflow", async () => {
  const f = await fixture();
  await saveWorkspace(f.graph, { x: 0, y: 0, zoom: 1 }, null);
  expect(
    (await loadWorkspace(f.graph.workflowId)).document.nodes[0].config,
  ).toEqual({ libraryRef: f.ref });
  const runner = new Runner(f.registry, runRepository, f.resolver);
  const first = await runner.run(f.snapshot, { signal: signal() });
  expect(first.state).toBe("succeeded");
  const saved = first.nodes.b.outputs!.out;
  expect(saved.type).toBe("image");
  if (saved.type !== "image") throw new Error("image expected");
  expect(saved.reference.scope).toBe("library");
  expect(saved.reference).not.toEqual(f.ref);
  const second = await runner.run(f.snapshot, {
    signal: signal(),
    retryOf: first.id,
  });
  const third = await runner.run(f.snapshot, {
    signal: signal(),
    retryOf: second.id,
  });
  expect(second.state).toBe("succeeded");
  expect(third.state).toBe("succeeded");
  expect(third.nodes.b.outputs!.out).toEqual(saved);
  expect(await listFiles()).toHaveLength(2);
  expect(
    (await runRepository.attempts(third.id)).find((a) => a.nodeId === "b")
      ?.cacheHit,
  ).toBe(false);
  expect(await sha256((await lookupLibrary(f.ref))!.blob)).toBe(f.ref.hash);
  const graph = {
    ...newWorkspace(),
    nodes: [{ ...newNode("source"), config: { libraryRef: saved.reference } }],
    edges: [],
  };
  const snapshot = await prepareSnapshot(
    graph,
    f.registry,
    f.resolver,
    versions,
    signal(),
  );
  expect((await runner.run(snapshot, { signal: signal() })).state).toBe(
    "succeeded",
  );
  expect(await read("libraryReceipts")).toHaveLength(1);
});
it("T14: bad or missing exact versions fail, documents cannot select both legacy and library inputs", async () => {
  const f = await fixture();
  const source = f.graph.nodes[0];
  await expect(
    prepareSnapshot(
      {
        ...f.graph,
        nodes: [
          {
            ...source,
            config: { libraryRef: { ...f.ref, versionId: "missing" } },
          },
        ],
        edges: [],
      },
      f.registry,
      f.resolver,
      versions,
      signal(),
    ),
  ).rejects.toMatchObject({ code: "ASSET_MISSING" });
  await expect(
    saveWorkspace(
      {
        ...f.graph,
        nodes: [
          {
            ...source,
            config: { libraryRef: f.ref, assetId: crypto.randomUUID() },
          },
        ],
        edges: [],
      },
      { x: 0, y: 0, zoom: 1 },
      null,
    ),
  ).rejects.toThrow();
});
it("T15: cancellation before save transaction has no save side effects", async () => {
  const f = await fixture(),
    abort = new AbortController();
  abort.abort();
  await expect(
    saveLibraryOutput(f.graph.nodes[1], {
      signal: abort.signal,
      snapshot: f.snapshot,
      nodeId: "b",
      inputs: { image: f.snapshot.sources.a },
      resolver: f.resolver,
      outputs: [],
      saveIdentity: { rootRunId: "root", runId: "run", attemptId: "attempt" },
    }),
  ).rejects.toThrow();
  expect(await listFiles()).toHaveLength(1);
  expect(await read("libraryReceipts")).toHaveLength(0);
});
it("T16: library ZIP roundtrip on fresh DB preserves refs, original bytes, folders and prevents duplicate restore", async () => {
  const f = await fixture();
  await putFolder({ id: "folder", name: "Folder", parentId: null });
  await updateFile(f.ref.fileId, { folderId: "folder" });
  await saveWorkspace(f.graph, { x: 0, y: 0, zoom: 1 }, null);
  const archive = new File(
    [await backupWorkspace(f.graph.workflowId)],
    "backup.zip",
  );
  vi.stubGlobal("indexedDB", new IDBFactory());
  const restored = await restoreWorkspace(archive);
  expect(await restoreWorkspace(archive)).toBe(restored);
  expect(await read<unknown[]>("workflows")).toHaveLength(1);
  expect((await loadWorkspace(restored)).document.nodes[0].config).toEqual({
    libraryRef: f.ref,
  });
  expect(await listFiles()).toHaveLength(1);
  expect(await listFolders()).toHaveLength(1);
  expect(
    await sha256((await versionFor((await listFiles())[0])).original),
  ).toBe(await sha256(image()));
});
it("T16: rejects bad library hashes and folder cycles without publishing any workflow", async () => {
  const f = await fixture();
  await saveWorkspace(f.graph, { x: 0, y: 0, zoom: 1 }, null);
  const zip = unzipSync(
    new Uint8Array(
      await (await backupWorkspace(f.graph.workflowId)).arrayBuffer(),
    ),
  );
  const manifest = JSON.parse(strFromU8(zip["manifest.json"]));
  manifest.library.versions[0].hash = "a".repeat(64);
  zip["manifest.json"] = strToU8(JSON.stringify(manifest));
  vi.stubGlobal("indexedDB", new IDBFactory());
  await expect(
    restoreWorkspace(new File([zipSync(zip)], "bad.zip")),
  ).rejects.toThrow("hash");
  expect(await read("workflows")).toEqual([]);
  manifest.library.folders = [{ id: "a", name: "A", parentId: "a" }];
  zip["manifest.json"] = strToU8(JSON.stringify(manifest));
  await expect(
    restoreWorkspace(new File([zipSync(zip)], "bad.zip")),
  ).rejects.toThrow("循環");
  expect(await read("libraryVersions")).toEqual([]);
});
it("T16: old v1 ZIP remains restorable and pre-aborted restore publishes nothing", async () => {
  const graph = newWorkspace();
  await saveWorkspace(graph, { x: 0, y: 0, zoom: 1 }, null);
  const zip = unzipSync(
    new Uint8Array(
      await (await backupWorkspace(graph.workflowId)).arrayBuffer(),
    ),
  );
  const manifest = JSON.parse(strFromU8(zip["manifest.json"]));
  manifest.formatVersion = 1;
  delete manifest.library;
  zip["manifest.json"] = strToU8(JSON.stringify(manifest));
  const file = new File([zipSync(zip)], "old.zip");
  vi.stubGlobal("indexedDB", new IDBFactory());
  const abort = new AbortController();
  abort.abort();
  await expect(restoreWorkspace(file, abort.signal)).rejects.toThrow();
  expect(await read("workflows")).toEqual([]);
  expect(await restoreWorkspace(file)).toBeTruthy();
});
it("migration v1→v2 retains old data and is repeatable", async () => {
  const db = await new Promise<IDBDatabase>((resolve) => {
    const r = indexedDB.open("axfluxo-workspace", 1);
    r.onupgradeneeded = () =>
      r.result
        .createObjectStore("workflows", { keyPath: "id" })
        .add({ id: "keep", document: "untouched" });
    r.onsuccess = () => resolve(r.result);
  });
  db.close();
  const upgraded = await openWorkspaceDB();
  expect(upgraded.version).toBe(2);
  upgraded.close();
  expect(await read("workflows", "keep")).toEqual({
    id: "keep",
    document: "untouched",
  });
  const again = await openWorkspaceDB();
  expect(again.objectStoreNames.contains("libraryReferences")).toBe(true);
  again.close();
});
it("T12: abort during encode and concurrent duplicate imports cannot leave partial files", async () => {
  const abort = new AbortController();
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toBlob: (cb: (b: Blob) => void) => {
        abort.abort();
        cb(new Blob([bytes], { type: "image/png" }));
      },
    }),
  });
  await expect(
    importLibraryImage(image(), null, abort.signal),
  ).rejects.toThrow();
  expect(await read("libraryVersions")).toEqual([]);
  const [first, second] = await Promise.all([
    importLibraryImage(image()),
    importLibraryImage(image()),
  ]);
  expect(first).toEqual(second);
  expect(await listFiles()).toHaveLength(1);
});
it("T15: history commit failure after save is recoverable without duplicate side effects", async () => {
  const f = await fixture();
  let failOnce = true;
  const repository = {
    ...runRepository,
    commit: async (...args: Parameters<typeof runRepository.commit>) => {
      if (failOnce && args[0].run.nodes.b?.state === "succeeded") {
        failOnce = false;
        throw new Error("history quota");
      }
      return runRepository.commit(...args);
    },
  };
  const runner = new Runner(f.registry, repository, f.resolver);
  const first = await runner.run(f.snapshot, { signal: signal() });
  expect(first.state).toBe("failed");
  expect(await read("libraryReceipts")).toHaveLength(1);
  const retry = await runner.run(f.snapshot, {
    signal: signal(),
    retryOf: first.id,
  });
  expect(retry.state).toBe("succeeded");
  expect(await listFiles()).toHaveLength(2);
  expect(await read("libraryReceipts")).toHaveLength(1);
});
it("T15: cancel as receipt is staged aborts file/version/receipt together", async () => {
  const f = await fixture(),
    abort = new AbortController(),
    add = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = add.apply(this, args);
    if (this.name === "libraryReceipts") abort.abort();
    return request;
  });
  await expect(
    saveLibraryOutput(f.graph.nodes[1], {
      signal: abort.signal,
      snapshot: f.snapshot,
      nodeId: "b",
      inputs: { image: f.snapshot.sources.a },
      resolver: f.resolver,
      outputs: [],
      saveIdentity: { rootRunId: "root", runId: "run", attemptId: "attempt" },
    }),
  ).rejects.toThrow();
  expect(await listFiles()).toHaveLength(1);
  expect(await read("libraryVersions")).toHaveLength(1);
  expect(await read("libraryReceipts")).toHaveLength(0);
});
it("T15: missing destination fails only the save node with no false success", async () => {
  const f = await fixture();
  const graph = {
    ...f.graph,
    nodes: f.graph.nodes.map((n) =>
      n.id === "b"
        ? { ...n, config: { name: "result", folderId: "missing" } }
        : n,
    ),
  };
  const snapshot = await prepareSnapshot(
    graph,
    f.registry,
    f.resolver,
    versions,
    signal(),
  );
  const run = await new Runner(f.registry, runRepository, f.resolver).run(
    snapshot,
    { signal: signal(), policy: "continue" },
  );
  expect(run.nodes.a.state).toBe("succeeded");
  expect(run.nodes.b.state).toBe("failed");
  expect(run.nodes.b.outputs).toBeUndefined();
  expect(await listFiles()).toHaveLength(1);
});
it("T16: restoring into the same library reuses matching immutable rows regardless of key insertion order", async () => {
  const f = await fixture();
  await saveWorkspace(f.graph, { x: 0, y: 0, zoom: 1 }, null);
  const file = new File(
    [await backupWorkspace(f.graph.workflowId)],
    "same-library.zip",
  );
  const id = await restoreWorkspace(file);
  expect(id).not.toBe(f.graph.workflowId);
  expect((await loadWorkspace(id)).document.nodes[0].config).toEqual({
    libraryRef: f.ref,
  });
  expect(await listFiles()).toHaveLength(1);
  expect(await restoreWorkspace(file)).toBe(id);
});
it("T16: cancellation during restore publication rolls back Workflow and all library rows", async () => {
  const f = await fixture();
  await saveWorkspace(f.graph, { x: 0, y: 0, zoom: 1 }, null);
  const file = new File(
    [await backupWorkspace(f.graph.workflowId)],
    "cancel.zip",
  );
  vi.stubGlobal("indexedDB", new IDBFactory());
  const abort = new AbortController(),
    add = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = add.apply(this, args);
    if (this.name === "libraryVersions") abort.abort();
    return request;
  });
  await expect(restoreWorkspace(file, abort.signal)).rejects.toThrow();
  expect(await read("workflows")).toEqual([]);
  expect(await read("libraryFiles")).toEqual([]);
  expect(await read("migrations")).toEqual([]);
});
