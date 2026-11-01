import {
  allVersionsDocumentSchema,
  toPersistentDocument,
  type AllVersionsDocument,
} from "../../domain/video/schema";
import { openDeveloperDB } from "../developer/db";
export async function saveVideoDocument(document: AllVersionsDocument) {
  const clean = toPersistentDocument(document),
    db = await openDeveloperDB();
  try {
    return await new Promise<AllVersionsDocument>((resolve, reject) => {
      const tx = db.transaction("documents", "readwrite"),
        store = tx.objectStore("documents"),
        get = store.get(clean.id);
      let next: AllVersionsDocument;
      get.onsuccess = () => {
        try {
          const old = get.result
            ? allVersionsDocumentSchema.parse(get.result.document)
            : null;
          if (old && old.revision !== clean.revision)
            throw new Error("VIDEO_CONFLICT");
          next = allVersionsDocumentSchema.parse({
            ...clean,
            revision: clean.revision + 1,
          });
          store.put({ id: next.id, document: next });
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
      tx.oncomplete = () => resolve(next!);
      tx.onabort = () => reject(tx.error ?? new Error("VIDEO_STORAGE"));
    });
  } finally {
    db.close();
  }
}
export async function loadVideoDocument(id: string) {
  const db = await openDeveloperDB();
  try {
    return await new Promise<AllVersionsDocument | null>((resolve, reject) => {
      const request = db
        .transaction("documents")
        .objectStore("documents")
        .get(id);
      request.onsuccess = () => {
        try {
          resolve(
            request.result
              ? allVersionsDocumentSchema.parse(request.result.document)
              : null,
          );
        } catch (e) {
          reject(e);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
