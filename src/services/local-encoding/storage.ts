import type { MediaVersionRef } from "../../domain/cloud-library/schema";
import type { AllVersionsProject } from "../../domain/video/all-versions";
import type { FnfShowcaseSnapshot } from "../../domain/video/fnf-showcase";
export type Snapshot = AllVersionsProject | FnfShowcaseSnapshot;
export type LocalJob = {
  id: string;
  owner: string;
  snapshot: Snapshot;
  outputIndex: number;
  filename: string;
  state:
    | "queued"
    | "running"
    | "resting"
    | "paused"
    | "cancelled"
    | "failed"
    | "completed";
  next: number;
  total: number;
  activeMs: number;
  restUntil: number;
  error?: string;
  createdAt: number;
};
export type LocalAsset = {
  reference: MediaVersionRef;
  blob: Blob;
  durationUs: number;
  width: number;
  height: number;
};
export const MAX_BYTES = 192 * 1024 * 1024;
function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("axfluxo-local-encoding-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("objects");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function read<T>(
  owner: string,
  key: string,
): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const r = db
        .transaction("objects")
        .objectStore("objects")
        .get(`${owner}:${key}`);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}
export async function write(owner: string, key: string, value: unknown) {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("objects", "readwrite");
      tx.objectStore("objects").put(value, `${owner}:${key}`);
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error ?? Error("端末への保存に失敗しました。"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function jobs(owner: string) {
  const db = await open();
  try {
    return await new Promise<LocalJob[]>((resolve, reject) => {
      const r = db
        .transaction("objects")
        .objectStore("objects")
        .getAll(IDBKeyRange.bound(`${owner}:job:`, `${owner}:job:\uffff`));
      r.onsuccess = () =>
        resolve(
          (r.result as LocalJob[]).sort((a, b) => a.createdAt - b.createdAt),
        );
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}
export async function removeJob(owner: string, id: string) {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("objects", "readwrite"),
        store = tx.objectStore("objects");
      store.delete(`${owner}:job:${id}`);
      store.delete(
        IDBKeyRange.bound(`${owner}:part:${id}:`, `${owner}:part:${id}:\uffff`),
      );
      store.delete(`${owner}:output:${id}`);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export const asset = (owner: string, id: string) =>
  read<LocalAsset>(owner, `asset:${id}`);
export const saveJob = (job: LocalJob) =>
  write(job.owner, `job:${job.id}`, job);
