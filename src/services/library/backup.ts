import { z } from "zod";
import { canonical } from "../workflow/cache";
import { openWorkspaceDB } from "../workspace/db";
import { sha256, imageMime, decodeImage } from "../assets";
import { validateImage } from "../workflow/asset-resolver";
import {
  libraryFileSchema,
  folderSchema,
  versionMetadataSchema,
  type LibraryVersion,
} from "../../domain/library";

const metadataSchema = z
  .object({
    files: z.array(libraryFileSchema).max(100),
    folders: z.array(folderSchema).max(100),
    versions: z.array(versionMetadataSchema).max(100),
  })
  .strict();
export type LibraryBackup = z.infer<typeof metadataSchema>;
const budget = 40 * 1024 * 1024;
export async function exportLibrary(
  entries: Record<string, Uint8Array>,
): Promise<LibraryBackup> {
  const db = await openWorkspaceDB();
  const snapshot = await new Promise<{
    files: unknown;
    folders: unknown;
    versions: LibraryVersion[];
  }>((resolve, reject) => {
    const tx = db.transaction([
      "libraryFiles",
      "libraryFolders",
      "libraryVersions",
    ]);
    const files = tx.objectStore("libraryFiles").getAll();
    const folders = tx.objectStore("libraryFolders").getAll();
    const versions = tx.objectStore("libraryVersions").getAll();
    tx.oncomplete = () =>
      resolve({
        files: files.result,
        folders: folders.result,
        versions: versions.result,
      });
    tx.onabort = () =>
      reject(tx.error ?? new Error("素材バックアップを読み込めません"));
  }).finally(() => db.close());
  const files = libraryFileSchema.array().max(100).parse(snapshot.files),
    folders = folderSchema.array().max(100).parse(snapshot.folders),
    versions = snapshot.versions;
  if (versions.length > 100)
    throw new Error("素材バックアップは100version以内にしてください");
  if (versions.reduce((n, v) => n + v.blob.size + v.original.size, 0) > budget)
    throw new Error("素材バックアップは合計40MiB以内にしてください");
  const metadata: LibraryBackup = { files, folders, versions: [] };
  for (const v of versions) {
    const { blob, original, ...meta } = v;
    await validateImage({ ...v, id: v.id }, v.hash, false);
    if ((await sha256(original)) !== v.originalHash)
      throw new Error("原本hashが一致しないためバックアップを中断しました");
    metadata.versions.push(versionMetadataSchema.parse(meta));
    entries[`library/${v.id}.image`] = new Uint8Array(await blob.arrayBuffer());
    entries[`library/${v.id}.original`] = new Uint8Array(
      await original.arrayBuffer(),
    );
  }
  return metadataSchema.parse(metadata);
}
export function parseLibraryMetadata(value: unknown) {
  return metadataSchema.parse(value);
}
export async function prepareLibraryRestore(
  raw: unknown,
  entries: Record<string, Uint8Array>,
  signal?: AbortSignal,
) {
  const metadata = metadataSchema.parse(raw);
  for (const rows of [metadata.files, metadata.folders, metadata.versions])
    if (new Set(rows.map((v) => v.id)).size !== rows.length)
      throw new Error("素材IDが重複しています");
  for (const folder of metadata.folders) {
    let parent: string | null = folder.id;
    const seen = new Set<string>();
    while (parent) {
      if (seen.has(parent)) throw new Error("フォルダが循環しています");
      seen.add(parent);
      const next = metadata.folders.find((f) => f.id === parent);
      if (!next) throw new Error("フォルダ参照が不足しています");
      parent = next.parentId;
    }
  }
  for (const file of metadata.files) {
    const v = metadata.versions.find((v) => v.id === file.versionId);
    if (
      !v ||
      v.fileId !== file.id ||
      v.libraryId !== file.libraryId ||
      file.kind !== "image" ||
      (file.folderId && !metadata.folders.some((f) => f.id === file.folderId))
    )
      throw new Error("素材の内部参照が不正です");
  }
  let total = 0;
  const versions: LibraryVersion[] = [];
  for (const meta of metadata.versions) {
    signal?.throwIfAborted();
    if (
      !metadata.files.some(
        (f) => f.id === meta.fileId && f.libraryId === meta.libraryId,
      )
    )
      throw new Error("versionの素材参照が不足しています");
    const image = entries[`library/${meta.id}.image`],
      original = entries[`library/${meta.id}.original`];
    if (!image || !original || original.length > 20 * 1024 * 1024)
      throw new Error("素材bytesが不足または過大です");
    total += image.length + original.length;
    if (total > budget)
      throw new Error("素材バックアップは合計40MiB以内にしてください");
    const blob = new Blob([new Uint8Array(image)], { type: meta.mime });
    const originalBlob = new Blob([new Uint8Array(original)], {
      type: meta.originalMime,
    });
    if (
      blob.size !== meta.size ||
      (await sha256(originalBlob)) !== meta.originalHash ||
      imageMime(original) !== meta.originalMime
    )
      throw new Error("素材の原本hashまたはMIMEが不正です");
    await validateImage({ ...meta, blob }, meta.hash);
    const decoded = await decodeImage(originalBlob);
    if (
      !decoded.naturalWidth ||
      !decoded.naturalHeight ||
      decoded.naturalWidth * decoded.naturalHeight > 24_000_000 ||
      Math.max(decoded.naturalWidth, decoded.naturalHeight) > 8192
    )
      throw new Error("素材原本が過大です");
    versions.push({ ...meta, blob, original: originalBlob });
  }
  return { metadata, versions };
}
/** Called within the same publication transaction as workflow restore. */
export function scheduleLibraryRestore(
  tx: IDBTransaction,
  data: Awaited<ReturnType<typeof prepareLibraryRestore>>,
  fail: (e: unknown) => void,
) {
  for (const [name, rows] of [
    ["libraryFolders", data.metadata.folders],
    ["libraryFiles", data.metadata.files],
    ["libraryVersions", data.versions],
  ] as const)
    for (const row of rows) {
      const r = tx.objectStore(name).get(row.id);
      r.onsuccess = () => {
        if (!r.result) {
          tx.objectStore(name).add(row);
          return;
        }
        if (name === "libraryVersions") {
          const old = r.result as LibraryVersion,
            v = row as LibraryVersion;
          if (
            old.hash !== v.hash ||
            old.originalHash !== v.originalHash ||
            old.fileId !== v.fileId ||
            old.libraryId !== v.libraryId
          )
            fail(new Error("既存versionと衝突しています"));
        } else if (canonical(r.result) !== canonical(row))
          fail(
            new Error(
              "既存の素材・フォルダと衝突しています。別端末で復元してください",
            ),
          );
      };
    }
}
