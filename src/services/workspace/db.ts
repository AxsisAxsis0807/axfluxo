export const stores = [
  "workflows",
  "preferences",
  "editorDocuments",
  "editorRevisions",
  "assets",
  "artifacts",
  "recovery",
  "migrations",
  "libraryFiles",
  "libraryVersions",
  "libraryFolders",
  "libraryReferences",
  "libraryReceipts",
] as const;
export type Store = (typeof stores)[number];
export function openWorkspaceDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("axfluxo-workspace", 2);
    let settled = false;
    r.onupgradeneeded = () => {
      for (const name of stores)
        if (!r.result.objectStoreNames.contains(name))
          r.result.createObjectStore(name, { keyPath: "id" });
    };
    r.onerror = () => reject(r.error ?? new Error("保存DBを開けません"));
    r.onblocked = () => {
      settled = true;
      reject(
        new Error(
          "保存DBがブロックされています。他のタブを閉じて再試行してください",
        ),
      );
    };
    r.onsuccess = () => {
      if (settled) {
        r.result.close();
        return;
      }
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
  });
}
export async function read<T>(store: Store, id?: string): Promise<T> {
  const db = await openWorkspaceDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store),
        r =
          id === undefined
            ? tx.objectStore(store).getAll()
            : tx.objectStore(store).get(id);
      let result: T;
      r.onsuccess = () => {
        result = r.result;
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error("読込を中断しました"));
    });
  } finally {
    db.close();
  }
}
/** Callbacks must schedule IDB requests synchronously; no decode/hash/render awaits. */
export async function write(
  names: Store[],
  schedule: (tx: IDBTransaction, fail: (e: unknown) => void) => void,
): Promise<void> {
  const db = await openWorkspaceDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(names, "readwrite");
      let error: unknown;
      const fail = (e: unknown) => {
        error ??= e;
        try {
          tx.abort();
        } catch {}
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(error ?? tx.error ?? new Error("保存を中断しました"));
      tx.onerror = () => {
        error ??= tx.error;
      };
      try {
        schedule(tx, fail);
      } catch (e) {
        fail(e);
      }
    });
  } finally {
    db.close();
  }
}
