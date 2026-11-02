import { openDeveloperDB } from "../developer/db";
import {
  persistentFnfPreferences,
  fnfPreferencesSchema,
  type FnfPreferences,
} from "../../domain/video/fnf-showcase";
export async function loadFnfPreferences(owner: string) {
  const db = await openDeveloperDB();
  try {
    return await new Promise<FnfPreferences | null>((resolve, reject) => {
      const q = db
        .transaction("documents")
        .objectStore("documents")
        .get(`fnf-preferences:${owner}`);
      q.onsuccess = () => {
        try {
          resolve(
            q.result ? fnfPreferencesSchema.parse(q.result.preferences) : null,
          );
        } catch (e) {
          reject(e);
        }
      };
      q.onerror = () => reject(q.error);
    });
  } finally {
    db.close();
  }
}
export async function saveFnfPreferences(
  owner: string,
  preferences: FnfPreferences,
) {
  const clean = persistentFnfPreferences(preferences),
    db = await openDeveloperDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("documents", "readwrite");
      tx.objectStore("documents").put({
        id: `fnf-preferences:${owner}`,
        preferences: clean,
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    return clean;
  } finally {
    db.close();
  }
}
