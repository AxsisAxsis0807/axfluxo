import { originalVersionSchema } from "../../domain/cloud-library/schema";
import { openDeveloperDB } from "./db";
/** Insert-only: duplicate identity aborts; never replace an original version. */
export async function addOriginalVersion(input: unknown): Promise<void> {
  const value = originalVersionSchema.parse(input);
  const db = await openDeveloperDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("originalVersions", "readwrite");
      const { libraryId, fileId, versionId } = value.reference;
      tx.objectStore("originalVersions").add({
        id: JSON.stringify([libraryId, fileId, versionId]),
        value,
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          new Error(
            tx.error?.name === "ConstraintError"
              ? "VIDEO_IMMUTABLE_VERSION"
              : "VIDEO_STORAGE",
          ),
        );
      tx.onerror = () => {
        /* onabort reports the durable outcome */
      };
    });
  } finally {
    db.close();
  }
}
