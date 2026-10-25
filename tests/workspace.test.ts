import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { newNode } from "../src/domain/workflow/schema";
import { parseWorkflow } from "../src/domain/workflow/connections";
import {
  parseWorkspace,
  referencedAssets,
} from "../src/domain/workspace/schema";
import {
  newImageEdit,
  newWorkspace,
  saveWorkspace,
  loadWorkspace,
  loadEditor,
  applyEditor,
  saveDraft,
  WorkspaceConflict,
  duplicateEditor,
} from "../src/services/workspace/repository";
import { read, openWorkspaceDB } from "../src/services/workspace/db";
import { Autosave } from "../src/services/workspace/autosave";
import { newText } from "../src/domain/document";
const view = { x: -80, y: 125, zoom: 0.5 };
async function fixture() {
  const pair = newImageEdit();
  pair.node.config.inputMode = "blank";
  const workflow = await saveWorkspace(
    { ...newWorkspace(), nodes: [pair.node] },
    view,
    null,
    { editors: [pair.editor] },
  );
  return { ...pair, workflow };
}
it("v2 accepts image-edit, v1 still refuses it and unknown versions/types fail", () => {
  const { node } = newImageEdit();
  const doc = { ...newWorkspace(), nodes: [node] };
  expect(parseWorkspace(doc)).toEqual(doc);
  expect(() => parseWorkflow({ ...doc, schemaVersion: 1 })).toThrow();
  for (const value of [
    { ...doc, schemaVersion: 3 },
    { ...doc, nodes: [{ ...node, typeVersion: 2 }] },
    { ...doc, nodes: [{ ...node, type: "unknown" }] },
  ])
    expect(() => parseWorkspace(value)).toThrow();
});
it("validates connections, single input, cycles and fanout for new nodes", () => {
  const a = newImageEdit().node,
    b = newImageEdit().node,
    c = newNode("save");
  const edge = {
    id: crypto.randomUUID(),
    sourceNodeId: a.id,
    sourcePortId: "out",
    targetNodeId: b.id,
    targetPortId: "in",
  };
  const doc = {
    ...newWorkspace(),
    nodes: [a, b, c],
    edges: [
      edge,
      {
        ...edge,
        id: crypto.randomUUID(),
        targetNodeId: c.id,
        targetPortId: "image",
      },
    ],
  };
  expect(() => parseWorkspace(doc)).not.toThrow();
  expect(() =>
    parseWorkspace({
      ...doc,
      edges: [
        ...doc.edges,
        {
          ...edge,
          id: crypto.randomUUID(),
          sourceNodeId: b.id,
          targetNodeId: a.id,
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    parseWorkspace({
      ...doc,
      edges: [edge, { ...edge, id: crypto.randomUUID() }],
    }),
  ).toThrow();
});
it("draft autosave never changes the applied revision, atomic apply verifies both CAS counters", async () => {
  const { node, editor, workflow } = await fixture();
  const first = await applyEditor(
    workflow,
    view,
    node.id,
    editor,
    workflow.revision,
    editor.revision,
    editor.document.pages[0].id,
  );
  const draft = structuredClone(first.editor);
  draft.document.pages[0].layers.push(newText());
  const saved = await saveDraft(draft, first.editor.revision);
  expect((await loadWorkspace(workflow.workflowId)).document.nodes[0]).toEqual(
    first.document.nodes[0],
  );
  await expect(
    applyEditor(
      first.document,
      view,
      node.id,
      saved,
      first.document.revision,
      first.editor.revision,
      saved.document.pages[0].id,
    ),
  ).rejects.toBeInstanceOf(WorkspaceConflict);
  expect((await loadEditor(editor.id)).document.pages[0].layers).toHaveLength(
    1,
  );
});
it("clones node editor and applied revision independently and keeps deleted documents for undo", async () => {
  const { node, editor, workflow } = await fixture();
  const first = await applyEditor(
      workflow,
      view,
      node.id,
      editor,
      0,
      0,
      editor.document.pages[0].id,
    ),
    applied = first.document.nodes[0];
  if (applied.type !== "image-edit") throw new Error();
  const pair = await duplicateEditor(applied);
  expect(pair.editor.id).not.toBe(editor.id);
  expect(pair.revision?.id).not.toBe(first.revision.id);
  const next = await saveWorkspace(
    { ...first.document, nodes: [applied, pair.node] },
    view,
    first.document.revision,
    { editors: [pair.editor], revisions: [pair.revision!] },
  );
  const removed = await saveWorkspace(
    { ...next, nodes: [] },
    view,
    next.revision,
  );
  expect(await loadEditor(editor.id)).toBeTruthy();
  expect(
    (
      await saveWorkspace(
        { ...removed, nodes: next.nodes },
        view,
        removed.revision,
      )
    ).nodes,
  ).toHaveLength(2);
});
it("quota/transaction abort rolls back apply and preserves old workflow and draft", async () => {
  const { node, editor, workflow } = await fixture();
  const original = IDBObjectStore.prototype.add;
  const spy = vi
    .spyOn(IDBObjectStore.prototype, "add")
    .mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["add"]>
    ) {
      if (this.name === "editorRevisions")
        throw new DOMException("quota", "QuotaExceededError");
      return original.apply(this, args);
    });
  try {
    await expect(
      applyEditor(
        workflow,
        view,
        node.id,
        editor,
        0,
        0,
        editor.document.pages[0].id,
      ),
    ).rejects.toThrow("quota");
  } finally {
    spy.mockRestore();
  }
  expect((await loadWorkspace(workflow.workflowId)).document).toEqual(workflow);
  expect((await loadEditor(editor.id)).revision).toBe(0);
  expect(
    (await read<{ editorDocumentId: string }[]>("editorRevisions")).filter(
      (r) => r.editorDocumentId === editor.id,
    ),
  ).toEqual([]);
});
it("collects both image variable defaults and current values", () => {
  const { editor } = newImageEdit(),
    a = crypto.randomUUID(),
    b = crypto.randomUUID();
  editor.document.variables.push({
    key: "photo",
    label: "photo",
    type: "image",
    required: false,
    default: a,
  });
  editor.document.values.photo = b;
  expect(new Set(referencedAssets(editor.document))).toEqual(new Set([a, b]));
});
it("save barrier awaits every generation without claiming new edits saved", async () => {
  let complete!: (v: { revision: number }) => void;
  const statuses: string[] = [];
  const write = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          complete = r;
        }),
    )
    .mockImplementation(async (_v, revision) => ({ revision: revision + 1 }));
  const saver = new Autosave<number, { revision: number }>(0, write, (s) =>
    statuses.push(s),
  );
  saver.edit(1);
  const flush = saver.flush();
  saver.edit(2);
  complete({ revision: 1 });
  await flush;
  expect(write).toHaveBeenCalledTimes(2);
  expect(saver.revision).toBe(2);
  expect(statuses.at(-1)).toBe("保存済み");
  saver.dispose();
});
it("blocked opens reject, late connections close and versionchange closes the new DB", async () => {
  const db = await openWorkspaceDB(),
    close = vi.spyOn(db, "close");
  db.onversionchange?.call(
    db,
    new Event("versionchange") as IDBVersionChangeEvent,
  );
  expect(close).toHaveBeenCalled();
  const request = { result: db } as IDBOpenDBRequest;
  const spy = vi.spyOn(indexedDB, "open").mockReturnValue(request);
  const pending = openWorkspaceDB();
  const assertion = expect(pending).rejects.toThrow("ブロック");
  request.onblocked?.call(
    request,
    new Event("blocked") as IDBVersionChangeEvent,
  );
  await assertion;
  request.onsuccess?.call(request, new Event("success"));
  expect(close).toHaveBeenCalledTimes(2);
  spy.mockRestore();
});
it("concurrent legacy imports are idempotent, copy assets and never mutate old DBs", async () => {
  const { put, get } = await import("../src/services/storage");
  const { saveWorkflow, loadWorkflow } =
    await import("../src/services/workflow/repository");
  const { importLegacyWorkflow } =
    await import("../src/services/workspace/migration");
  const { newWorkflow } = await import("../src/domain/workflow/schema");
  const assetId = crypto.randomUUID(),
    blob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
      type: "image/png",
    });
  await put("assets", {
    id: assetId,
    name: "old.png",
    width: 1,
    height: 1,
    hash: "old-hash-is-not-trusted",
    mime: "image/png",
    blob,
    original: blob,
  });
  const source = newNode("source");
  source.config = { assetId };
  const old = await saveWorkflow(
    { ...newWorkflow(), nodes: [source] },
    view,
    null,
  );
  const before = await loadWorkflow(old.workflowId),
    beforeAsset = await get("assets", assetId);
  const [a, b] = await Promise.all([
    importLegacyWorkflow(old.workflowId),
    importLegacyWorkflow(old.workflowId),
  ]);
  expect(a).toBe(b);
  expect(a).not.toBe(old.workflowId);
  expect(await loadWorkflow(old.workflowId)).toEqual(before);
  expect(await get("assets", assetId)).toEqual(beforeAsset);
  const migrated = (await loadWorkspace(a)).document;
  expect(migrated.nodes[0].id).not.toBe(source.id);
  if (!("assetId" in migrated.nodes[0].config)) throw new Error();
  expect(migrated.nodes[0].config.assetId).not.toBe(assetId);
  await saveWorkflow({ ...old, name: "updated original" }, view, old.revision);
  expect(await importLegacyWorkflow(old.workflowId)).not.toBe(a);
});
it("cancelled and stale generation results cannot replace an existing output", async () => {
  const { publishArtifact, currentOutput } =
    await import("../src/services/workspace/repository");
  const { node, editor, workflow } = await fixture();
  const applied = await applyEditor(
    workflow,
    view,
    node.id,
    editor,
    0,
    0,
    editor.document.pages[0].id,
  );
  const output = {
    id: crypto.randomUUID(),
    key: "a".repeat(64),
    revisionId: applied.revision.id,
    pageId: editor.document.pages[0].id,
    blob: new Blob(["image"]),
    thumbnail: new Blob(["thumb"]),
    hash: "b".repeat(64),
    width: 1080,
    height: 1080,
    format: "png" as const,
  };
  expect(
    await publishArtifact(
      workflow.workflowId,
      node.id,
      output,
      new AbortController().signal,
    ),
  ).toBe(true);
  const controller = new AbortController();
  controller.abort();
  await expect(
    publishArtifact(
      workflow.workflowId,
      node.id,
      { ...output, id: crypto.randomUUID() },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(
    await publishArtifact(
      workflow.workflowId,
      node.id,
      { ...output, id: crypto.randomUUID(), revisionId: crypto.randomUUID() },
      new AbortController().signal,
    ),
  ).toBe(false);
  expect((await currentOutput(workflow.workflowId, node.id))?.id).toBe(
    output.id,
  );
});
it("missing image variables abort drafts and keep the stored record unchanged", async () => {
  const { editor } = await fixture();
  const next = structuredClone(editor);
  next.document.variables.push({
    key: "photo",
    label: "photo",
    type: "image",
    required: false,
    default: crypto.randomUUID(),
  });
  await expect(saveDraft(next, 0)).rejects.toThrow("画像対応表");
  expect((await loadEditor(editor.id)).document.variables).toEqual([]);
});
it("unknown stored schemas are refused without overwriting the original record", async () => {
  const { write } = await import("../src/services/workspace/db");
  const document = { ...newWorkspace(), schemaVersion: 99 };
  await write(["workflows"], (tx) => {
    tx.objectStore("workflows").add({ id: document.workflowId, document });
  });
  await expect(loadWorkspace(document.workflowId)).rejects.toThrow();
  await expect(
    saveWorkspace({ ...document, schemaVersion: 2 }, view, 0),
  ).rejects.toThrow();
  expect(await read("workflows", document.workflowId)).toEqual({
    id: document.workflowId,
    document,
  });
  await write(["workflows"], (tx) => {
    tx.objectStore("workflows").delete(document.workflowId);
  });
});
it("a development effect remount can resume its save coordinator", async () => {
  const write = vi.fn(async (_value: number, revision: number) => ({
    revision: revision + 1,
  }));
  const saver = new Autosave<number, { revision: number }>(0, write, () => {});
  saver.dispose();
  saver.resume();
  saver.edit(1);
  await saver.flush();
  expect(write).toHaveBeenCalledOnce();
  expect(saver.dirty).toBe(false);
  saver.dispose();
});
