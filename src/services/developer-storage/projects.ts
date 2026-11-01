import { openDeveloperDB } from "../developer/db";
import {
  allVersionsProjectSchema,
  type AllVersionsProject,
} from "../../domain/video/all-versions";
export type LocalProject = {
  id: string;
  owner: string;
  revision: number;
  cloudRevision: number;
  project: AllVersionsProject;
  conflict?: AllVersionsProject;
};
export type SyncEntry = {
  id: string;
  owner: string;
  projectId: string;
  revision: number;
  expected: number;
  project: AllVersionsProject;
};
export class ProjectConflict extends Error {
  constructor(
    readonly local: AllVersionsProject,
    readonly stored: AllVersionsProject,
  ) {
    super("PROJECT_CONFLICT");
  }
}
const key = (owner: string, id: string) => `av5:${owner}:${id}`;
export async function localProject(
  owner: string,
  id: string,
): Promise<LocalProject | null> {
  const db = await openDeveloperDB();
  try {
    return await new Promise((resolve, reject) => {
      const q = db
        .transaction("documents")
        .objectStore("documents")
        .get(key(owner, id));
      q.onsuccess = () => resolve(q.result ?? null);
      q.onerror = () => reject(q.error);
    });
  } finally {
    db.close();
  }
}
/** CAS plus durable sync outbox in the same native IDB transaction; no schema upgrade. */
export async function saveProject(
  owner: string,
  project: AllVersionsProject,
  expected: number,
): Promise<LocalProject> {
  const clean = allVersionsProjectSchema.parse(project),
    db = await openDeveloperDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(["documents", "snapshots"], "readwrite"),
        store = tx.objectStore("documents"),
        q = store.get(key(owner, clean.id));
      let result: LocalProject;
      let conflict: ProjectConflict | undefined;
      q.onsuccess = () => {
        try {
          const old = q.result as LocalProject | undefined;
          if ((old?.revision ?? 0) !== expected) {
            conflict = new ProjectConflict(clean, old?.project ?? clean);
            tx.objectStore("snapshots").put({
              id: `conflict:${key(owner, clean.id)}:${crypto.randomUUID()}`,
              kind: "av5-conflict",
              owner,
              projectId: clean.id,
              project: clean,
              createdAt: Date.now(),
            });
            return;
          }
          result = {
            id: key(owner, clean.id),
            owner,
            revision: expected + 1,
            cloudRevision: old?.cloudRevision ?? 0,
            project: clean,
            ...(old?.conflict ? { conflict: old.conflict } : {}),
          };
          store.put(result);
          tx.objectStore("snapshots").put({
            id: `sync:${key(owner, clean.id)}`,
            owner,
            projectId: clean.id,
            revision: result.revision,
            expected: result.cloudRevision,
            project: clean,
          } satisfies SyncEntry);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
      tx.oncomplete = () => (conflict ? reject(conflict) : resolve(result!));
      tx.onabort = () => reject(tx.error ?? new Error("LOCAL_QUOTA"));
      tx.onerror = () => {};
    });
  } finally {
    db.close();
  }
}
export async function syncEntry(
  owner: string,
  id: string,
): Promise<SyncEntry | null> {
  const db = await openDeveloperDB();
  try {
    return await new Promise((resolve, reject) => {
      const q = db
        .transaction("snapshots")
        .objectStore("snapshots")
        .get(`sync:${key(owner, id)}`);
      q.onsuccess = () => resolve(q.result ?? null);
      q.onerror = () => reject(q.error);
    });
  } finally {
    db.close();
  }
}
export async function acknowledge(
  owner: string,
  id: string,
  sent: number,
  cloudRevision: number,
  remoteConflict?: AllVersionsProject,
) {
  const db = await openDeveloperDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["documents", "snapshots"], "readwrite"),
        docs = tx.objectStore("documents"),
        out = tx.objectStore("snapshots"),
        q = docs.get(key(owner, id));
      q.onsuccess = () => {
        const row = q.result as LocalProject | undefined;
        if (!row) return;
        if (remoteConflict) {
          docs.put({ ...row, conflict: remoteConflict });
          return;
        }
        if (cloudRevision < row.cloudRevision) return;
        docs.put({ ...row, cloudRevision });
        const next = out.get(`sync:${key(owner, id)}`);
        next.onsuccess = () => {
          const entry = next.result as SyncEntry | undefined;
          if (!entry) return;
          if (entry.revision === sent) out.delete(entry.id);
          else out.put({ ...entry, expected: cloudRevision });
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function forkConflict(
  owner: string,
  id: string,
  proposed?: AllVersionsProject,
) {
  const row = await localProject(owner, id);
  if (!row) throw new Error("PROJECT_NOT_FOUND");
  const fork = { ...(proposed ?? row.project), id: crypto.randomUUID() };
  return saveProject(owner, fork, 0);
}

export async function conflictDrafts(
  owner: string,
  id: string,
): Promise<AllVersionsProject[]> {
  const db = await openDeveloperDB();
  try {
    return await new Promise((resolve, reject) => {
      const q = db.transaction("snapshots").objectStore("snapshots").getAll();
      q.onsuccess = () =>
        resolve(
          q.result
            .filter(
              (r) =>
                r.kind === "av5-conflict" &&
                r.owner === owner &&
                r.projectId === id,
            )
            .map((r) => allVersionsProjectSchema.parse(r.project)),
        );
      q.onerror = () => reject(q.error);
    });
  } finally {
    db.close();
  }
}
export async function listProjects(
  owner: string,
): Promise<{ id: string; revision: number }[]> {
  const db = await openDeveloperDB();
  try {
    return await new Promise((resolve, reject) => {
      const items: { id: string; revision: number }[] = [];
      const q = db
        .transaction("documents")
        .objectStore("documents")
        .openCursor();
      q.onsuccess = () => {
        const cursor = q.result;
        if (!cursor) {
          resolve(items);
          return;
        }
        const r = cursor.value;
        if (r.owner === owner && r.project?.kind === "all-versions-project")
          items.push({ id: r.project.id, revision: r.revision });
        cursor.continue();
      };
      q.onerror = () => reject(q.error);
    });
  } finally {
    db.close();
  }
}
