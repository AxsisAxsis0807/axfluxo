import { parseWorkflow } from "../../domain/workflow/connections";
import {
  viewportSchema,
  type Viewport,
  type WorkflowDocument,
} from "../../domain/workflow/schema";
import { openWorkflowDB, requestValue } from "./db";
export class WorkflowConflict extends Error {
  constructor() {
    super(
      "別タブの更新と競合しました。再読込または別コピー保存を選んでください",
    );
  }
}
export async function loadWorkflow(id: string) {
  const db = await openWorkflowDB();
  try {
    const tx = db.transaction(["workflows", "preferences"]);
    const [row, pref] = await Promise.all([
      requestValue(tx.objectStore("workflows").get(id)),
      requestValue(tx.objectStore("preferences").get(id)),
    ]);
    return {
      document: row ? parseWorkflow(row.document) : undefined,
      viewport: pref
        ? viewportSchema.parse(pref.viewport)
        : { x: 0, y: 0, zoom: 1 },
    };
  } finally {
    db.close();
  }
}
export async function latestWorkflowId(): Promise<string | undefined> {
  const db = await openWorkflowDB();
  try {
    const rows = await requestValue(
      db.transaction("workflows").objectStore("workflows").getAll(),
    );
    // Refuse unknown data instead of silently creating and overwriting another document.
    return rows
      .map((r) => parseWorkflow(r.document))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.workflowId;
  } finally {
    db.close();
  }
}
export async function saveWorkflow(
  value: WorkflowDocument,
  viewport: Viewport,
  expected: number | null,
): Promise<WorkflowDocument> {
  const d = parseWorkflow({
    ...value,
    revision: (expected ?? -1) + 1,
    updatedAt: new Date().toISOString(),
  });
  const v = viewportSchema.parse(viewport),
    db = await openWorkflowDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        ["workflows", "recovery", "preferences"],
        "readwrite",
      );
      let error: unknown;
      const store = tx.objectStore("workflows"),
        r = store.get(d.workflowId);
      r.onsuccess = () => {
        try {
          const existing = r.result
            ? parseWorkflow(r.result.document)
            : undefined;
          if ((existing?.revision ?? null) !== expected) {
            error = new WorkflowConflict();
            tx.abort();
            return;
          }
          store.put({ id: d.workflowId, document: d });
          tx.objectStore("preferences").put({ id: d.workflowId, viewport: v });
          const recovery = tx.objectStore("recovery");
          recovery.put({
            id: `${d.workflowId}:${d.revision}`,
            workflowId: d.workflowId,
            document: d,
          });
          const all = recovery.getAll();
          all.onsuccess = () => {
            all.result
              .filter((r) => r.workflowId === d.workflowId)
              .sort((a, b) => b.document.revision - a.document.revision)
              .slice(5)
              .forEach((r) => recovery.delete(r.id));
          };
        } catch (e) {
          error = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(error ?? tx.error ?? new Error("保存を中断しました"));
      tx.onerror = () => {
        error ??= tx.error;
      };
    });
    return d;
  } finally {
    db.close();
  }
}
export async function recoveryHistory(id: string): Promise<WorkflowDocument[]> {
  const db = await openWorkflowDB();
  try {
    const rows = await requestValue(
      db.transaction("recovery").objectStore("recovery").getAll(),
    );
    return rows
      .filter((r) => r.workflowId === id)
      .map((r) => parseWorkflow(r.document))
      .sort((a, b) => b.revision - a.revision);
  } finally {
    db.close();
  }
}
