export function openWorkflowDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("axfluxo-workflow", 1);
    let settled = false;
    r.onupgradeneeded = () => {
      for (const name of ["workflows", "recovery", "preferences"])
        r.result.createObjectStore(name, { keyPath: "id" });
    };
    r.onblocked = () => {
      settled = true;
      reject(
        new Error(
          "保存DBがブロックされています。他のタブを閉じて再試行してください",
        ),
      );
    };
    r.onerror = () => reject(r.error ?? new Error("保存DBを開けません"));
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
export function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
