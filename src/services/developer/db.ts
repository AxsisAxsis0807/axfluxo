/** Opt-in only. No app entry imports this module and import itself never opens IDB. */
export const DEVELOPER_DB_NAME = "axfluxo-developer";
export const DEVELOPER_DB_VERSION = 1;
export const DEVELOPER_STORES = [
  "documents",
  "originalVersions",
  "snapshots",
  "renderJobs",
  "saveConfirmations",
] as const;
export function openDeveloperDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVELOPER_DB_NAME, DEVELOPER_DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      for (const name of DEVELOPER_STORES)
        request.result.createObjectStore(name, { keyPath: "id" });
    };
    request.onerror = () => reject(request.error ?? new Error("VIDEO_STORAGE"));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("VIDEO_STORAGE_BLOCKED"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
