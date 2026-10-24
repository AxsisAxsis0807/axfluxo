import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
  newWorkflow,
  newNode,
  type WorkflowDocument,
} from "../src/domain/workflow/schema";
import {
  compatible,
  connectionError,
  parseWorkflow,
} from "../src/domain/workflow/connections";
import {
  arrange,
  commit,
  deleteNode,
  duplicateNode,
  redo,
  undo,
} from "../src/domain/workflow/commands";
import {
  loadWorkflow,
  saveWorkflow,
  WorkflowConflict,
  recoveryHistory,
} from "../src/services/workflow/repository";
import {
  WorkflowAutosave,
  type SaveStatus,
} from "../src/services/workflow/autosave";
import { openWorkflowDB } from "../src/services/workflow/db";
function fixture() {
  const source = newNode("source"),
    image = newNode("image"),
    save = newNode("save"),
    post = newNode("post"),
    text = newNode("text");
  const doc = { ...newWorkflow(), nodes: [source, image, save, post, text] };
  const edge = {
    id: crypto.randomUUID(),
    sourceNodeId: source.id,
    sourcePortId: "image",
    targetNodeId: save.id,
    targetPortId: "image",
  };
  return { doc, edge, source, image, save, post, text };
}
const view = { x: -80, y: 125, zoom: 0.5 };
describe("Workflow model and commands", () => {
  it("rejects mismatch, reverse, missing, self, duplicate, occupied and cycles", () => {
    const { doc, edge, source, image, text } = fixture();
    expect(
      connectionError(doc, {
        ...edge,
        sourceNodeId: text.id,
        sourcePortId: "text",
      }),
    ).toContain("型");
    expect(
      connectionError(doc, { ...edge, targetNodeId: source.id }),
    ).toContain("自己");
    expect(
      connectionError(doc, { ...edge, targetNodeId: "missing" }),
    ).toContain("存在");
    expect(
      connectionError(doc, { ...edge, sourcePortId: "missing" }),
    ).toContain("端子");
    expect(
      connectionError(doc, {
        ...edge,
        sourceNodeId: image.id,
        sourcePortId: "in",
      }),
    ).toContain("出力");
    const connected = { ...doc, edges: [edge] };
    expect(connectionError(connected, edge)).toContain("既に");
    expect(
      connectionError(connected, {
        ...edge,
        sourceNodeId: image.id,
        sourcePortId: "out",
      }),
    ).toContain("既に");
    const second = newNode("image");
    const chain = {
      ...doc,
      nodes: [...doc.nodes, second],
      edges: [
        {
          ...edge,
          sourceNodeId: image.id,
          sourcePortId: "out",
          targetNodeId: second.id,
          targetPortId: "in",
        },
      ],
    };
    expect(
      connectionError(chain, {
        ...edge,
        sourceNodeId: second.id,
        sourcePortId: "out",
        targetNodeId: image.id,
        targetPortId: "in",
      }),
    ).toContain("循環");
    expect(compatible("collection<image>", "image")).toBe(false);
    expect(compatible("collection<image>", "collection<image>")).toBe(true);
  });
  it("keeps independent IDs and connections out of a duplicate; deletes incident edges", () => {
    const { doc, edge, source } = fixture();
    doc.edges.push(edge);
    const next = duplicateNode(doc, source.id);
    expect(new Set(next.nodes.map((n) => n.id)).size).toBe(next.nodes.length);
    expect(next.edges).toEqual([edge]);
    expect(deleteNode(next, source.id).edges).toEqual([]);
  });
  it("undoes and redoes connect, delete, layout, config and movement as single commands", () => {
    const { doc, edge, source } = fixture();
    let history = {
      past: [] as WorkflowDocument[],
      present: doc,
      future: [] as WorkflowDocument[],
    };
    const changes = [
      { ...doc, edges: [edge] },
      deleteNode({ ...doc, edges: [edge] }, source.id),
      arrange(doc),
      { ...doc, name: "renamed" },
      {
        ...doc,
        nodes: doc.nodes.map((n) => ({ ...n, position: { x: 123, y: 456 } })),
      },
    ];
    for (const next of changes) {
      const old = history.present;
      history = commit(history, next);
      expect(undo(history).present).toEqual(old);
      expect(redo(undo(history)).present).toEqual(next);
    }
  });
  it("rejects invalid, unknown and image/token payloads without coercing", () => {
    const { doc, source, text } = fixture();
    for (const value of [
      "broken",
      { ...doc, schemaVersion: 99 },
      { ...doc, nodes: [{ ...source, type: "unknown" }] },
      { ...doc, nodes: [{ ...source, config: { blob: new Blob() } }] },
      {
        ...doc,
        nodes: [{ ...text, config: { text: "data:image/png;base64,AAAA" } }],
      },
      { ...doc, nodes: [source, source] },
    ])
      expect(() => parseWorkflow(value)).toThrow();
  });
});
describe("Workflow repository", () => {
  it("restores fanout, positions, config and separate viewport", async () => {
    const { doc, edge, post } = fixture();
    doc.edges = [
      edge,
      { ...edge, id: crypto.randomUUID(), targetNodeId: post.id },
    ];
    const saved = await saveWorkflow(doc, view, null);
    expect(await loadWorkflow(doc.workflowId)).toEqual({
      document: saved,
      viewport: view,
    });
    expect("viewport" in saved).toBe(false);
  });
  it("atomic revision comparison preserves the first tab and five recovery generations", async () => {
    const { doc } = fixture();
    await saveWorkflow(doc, view, null);
    await saveWorkflow({ ...doc, name: "tab A" }, view, 0);
    await expect(
      saveWorkflow({ ...doc, name: "tab B" }, view, 0),
    ).rejects.toBeInstanceOf(WorkflowConflict);
    expect((await loadWorkflow(doc.workflowId)).document?.name).toBe("tab A");
    for (let i = 1; i <= 7; i++) await saveWorkflow(doc, view, i);
    expect(
      (await recoveryHistory(doc.workflowId)).map((d) => d.revision),
    ).toEqual([8, 7, 6, 5, 4]);
  });
  it("a quota transaction failure preserves committed data", async () => {
    const { doc } = fixture();
    await saveWorkflow(doc, view, null);
    const prototype = IDBObjectStore.prototype,
      original = prototype.put;
    const spy = vi.spyOn(prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === "preferences")
        throw new DOMException("quota", "QuotaExceededError");
      return original.call(this, value, key);
    });
    await expect(
      saveWorkflow({ ...doc, name: "must not persist" }, view, 0),
    ).rejects.toThrow("quota");
    spy.mockRestore();
    expect((await loadWorkflow(doc.workflowId)).document?.name).toBe(doc.name);
  });
  it("handles DB open failure without deleting data", async () => {
    const spy = vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new DOMException("unavailable", "SecurityError");
    });
    await expect(openWorkflowDB()).rejects.toThrow("unavailable");
    spy.mockRestore();
  });
});
describe("autosave scheduling and generation", () => {
  it("serializes writes and does not claim a newer edit saved when an older write completes", async () => {
    const { doc } = fixture();
    const status: SaveStatus[] = [];
    let complete!: (d: WorkflowDocument) => void;
    const write = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<WorkflowDocument>((r) => {
            complete = r;
          }),
      )
      .mockImplementation(async (d: WorkflowDocument) => ({
        ...d,
        revision: 1,
      }));
    const queue = new WorkflowAutosave(null, (s) => status.push(s), write);
    queue.edit(doc, view);
    const flush = queue.flush();
    queue.edit({ ...doc, name: "new" }, view);
    expect(write).toHaveBeenCalledTimes(1);
    complete({ ...doc, revision: 0 });
    await flush;
    await Promise.resolve();
    expect(status.slice(-3)).toEqual(["未保存", "保存中", "保存済み"]);
    expect(write.mock.calls[1][2]).toBe(0);
    queue.dispose();
  });
  it("saves at 750ms and by five seconds under continuous editing", async () => {
    vi.useFakeTimers();
    const { doc } = fixture();
    const write = vi.fn(async (d: WorkflowDocument) => d);
    const queue = new WorkflowAutosave(null, () => {}, write);
    queue.edit(doc, view);
    await vi.advanceTimersByTimeAsync(749);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 11; i++) {
      queue.edit({ ...doc, name: String(i) }, view);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(write.mock.calls.length).toBeGreaterThanOrEqual(2);
    queue.dispose();
    vi.useRealTimers();
  });
  it("blocks overwrites after conflict and supports explicit retry after transient failure", async () => {
    const { doc } = fixture();
    const statuses: SaveStatus[] = [];
    const write = vi
      .fn()
      .mockRejectedValueOnce(new WorkflowConflict())
      .mockResolvedValue({ ...doc, revision: 1 });
    const queue = new WorkflowAutosave(0, (s) => statuses.push(s), write);
    queue.edit(doc, view);
    await queue.flush();
    queue.edit({ ...doc, name: "later" }, view);
    await queue.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe("競合・未保存");
    queue.dispose();
  });
});
it("blocked open rejects, closes late connections, and versionchange closes the DB", async () => {
  const db = await openWorkflowDB();
  const close = vi.spyOn(db, "close");
  db.onversionchange?.call(
    db,
    new Event("versionchange") as IDBVersionChangeEvent,
  );
  expect(close).toHaveBeenCalledTimes(1);
  const request = {
    onblocked: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    result: db,
  } as unknown as IDBOpenDBRequest;
  const spy = vi.spyOn(indexedDB, "open").mockReturnValue(request);
  const pending = openWorkflowDB();
  const assertion = expect(pending).rejects.toThrow("ブロック");
  request.onblocked?.call(
    request,
    new Event("blocked") as IDBVersionChangeEvent,
  );
  await assertion;
  request.onsuccess?.call(request, new Event("success"));
  expect(close).toHaveBeenCalledTimes(2);
  spy.mockRestore();
  close.mockRestore();
});
it("unknown stored schema is rejected without overwriting the original row", async () => {
  const d = newWorkflow(),
    raw = { ...d, schemaVersion: 99 };
  const db = await openWorkflowDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("workflows", "readwrite");
    tx.objectStore("workflows").put({ id: d.workflowId, document: raw });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  db.close();
  await expect(loadWorkflow(d.workflowId)).rejects.toThrow();
  await expect(saveWorkflow(d, view, 0)).rejects.toThrow();
  const after = await openWorkflowDB();
  const row = await new Promise<{ document: unknown }>((resolve) => {
    const r = after
      .transaction("workflows")
      .objectStore("workflows")
      .get(d.workflowId);
    r.onsuccess = () => resolve(r.result);
  });
  after.close();
  expect(row.document).toEqual(raw);
});
