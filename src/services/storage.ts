import { documentSchema, type ProjectDocument } from "../domain/document";
export type Asset = {
  id: string;
  name: string;
  width: number;
  height: number;
  hash: string;
  mime: string;
  original: Blob;
  blob: Blob;
};
export type Template = {
  id: string;
  name: string;
  description: string;
  version: number;
  document: ProjectDocument;
  createdAt: string;
};
export class ConflictError extends Error {
  constructor() {
    super("別タブの更新と競合しました。コピーとして保存してください。");
  }
}
let database: Promise<IDBDatabase> | undefined;
export function db() {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open("axfluxo", 1);
      request.onupgradeneeded = () => {
        for (const name of ["projects", "revisions", "assets", "templates"])
          request.result.createObjectStore(name, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  return database;
}
export async function all<T>(name: string): Promise<T[]> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const q = database.transaction(name).objectStore(name).getAll();
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
}
export async function get<T>(name: string, id: string): Promise<T | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const q = database.transaction(name).objectStore(name).get(id);
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
}
export async function put<T>(name: string, value: T) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction(name, "readwrite");
    tx.objectStore(name).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export async function remove(name: string, id: string) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction(name, "readwrite");
    tx.objectStore(name).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function saveProject(
  document: ProjectDocument,
  expectedRevision: number | null,
) {
  const d = documentSchema.parse(document),
    database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction(
      ["projects", "revisions", "assets"],
      "readwrite",
    );
    const store = tx.objectStore("projects");
    const request = store.get(d.id);
    let conflict = false;
    request.onsuccess = () => {
      const existing = request.result as ProjectDocument | undefined;
      if ((existing?.revision ?? null) !== expectedRevision) {
        conflict = true;
        tx.abort();
        return;
      }
      const assetIds = d.pages.flatMap((p) =>
        p.layers.flatMap((l) => (l.kind === "image" ? [l.assetId] : [])),
      );
      for (const v of d.variables.filter((v) => v.type === "image")) {
        const id = d.values[v.key] ?? v.default;
        if (typeof id === "string" && id) assetIds.push(id);
      }
      let remaining = assetIds.length;
      const write = () => {
        store.put(d);
        if (existing)
          tx.objectStore("revisions").put({
            id: `${d.id}:${existing.revision}`,
            projectId: d.id,
            document: existing,
          });
      };
      if (!remaining) write();
      for (const id of assetIds) {
        const r = tx.objectStore("assets").get(id);
        r.onsuccess = () => {
          if (!r.result) {
            tx.abort();
            return;
          }
          if (--remaining === 0) write();
        };
      }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        conflict
          ? new ConflictError()
          : (tx.error ?? new Error("画像参照または保存に失敗しました")),
      );
    tx.onerror = () => reject(tx.error);
  });
  void pruneRevisions(d.id).catch(() => {
    /* A failed cleanup must not report an already committed save as failed. */
  });
}
async function pruneRevisions(projectId: string) {
  const revisions = await all<{
    id: string;
    projectId: string;
    document: ProjectDocument;
  }>("revisions");
  const excess = revisions
    .filter((r) => r.projectId === projectId)
    .sort((a, b) => b.document.revision - a.document.revision)
    .slice(5);
  for (const r of excess) await remove("revisions", r.id);
}
export class SaveQueue {
  private queue: Promise<void> = Promise.resolve();
  enqueue(task: () => Promise<void>) {
    const next = this.queue.catch(() => {}).then(task);
    this.queue = next;
    return next;
  }
}
export async function saveTemplateVersion(
  template: Template & { templateId: string },
  expectedVersion: number,
) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction("templates", "readwrite");
    const store = tx.objectStore("templates");
    const request = store.getAll();
    let conflict = false;
    request.onsuccess = () => {
      const current = (request.result as (Template & { templateId?: string })[])
        .filter((t) => (t.templateId ?? t.id) === template.templateId)
        .reduce((v, t) => Math.max(v, t.version), 0);
      if (current !== expectedVersion) {
        conflict = true;
        tx.abort();
        return;
      }
      store.add(template);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        conflict
          ? new Error(
              "テンプレートが別タブで更新されました。再読み込みして新しい版から編集してください。",
            )
          : tx.error,
      );
    tx.onerror = () => reject(tx.error);
  });
}
