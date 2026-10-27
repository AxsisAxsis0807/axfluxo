import { read, write as workspaceWrite } from "../workspace/db";
async function write(...args: Parameters<typeof workspaceWrite>) {
  try {
    await workspaceWrite(...args);
  } catch (e) {
    if ((e as { name?: string })?.name === "QuotaExceededError")
      throw new ExecutionError(
        "STORAGE_QUOTA",
        "端末の空き容量が不足しているため保存できません",
      );
    throw e;
  }
}
function guarded(fail: (e: unknown) => void, fn: () => void) {
  return () => {
    try {
      fn();
    } catch (e) {
      fail(e);
    }
  };
}
import { importImage, sha256 } from "../assets";
import { validateImage, imageValue } from "../workflow/asset-resolver";
import {
  libraryRef,
  libraryReferenceSchema,
  libraryFileSchema,
  folderSchema,
  type LibraryFile,
  type LibraryFolder,
  type LibraryVersion,
  type LibraryRef,
} from "../../domain/library";
import {
  ExecutionError,
  type Output,
  type NodeContext,
  type Graph,
} from "../../domain/workflow/execution";
export const LIBRARY_ID = "local";
export const listFiles = async () =>
  libraryFileSchema.array().parse(await read("libraryFiles"));
export const listFolders = async () =>
  folderSchema.array().parse(await read("libraryFolders"));
export async function lookupLibrary(
  raw: LibraryRef,
): Promise<Output | undefined> {
  const ref = libraryReferenceSchema.parse(raw);
  const v = await read<LibraryVersion | undefined>(
    "libraryVersions",
    ref.versionId,
  );
  if (
    !v ||
    v.fileId !== ref.fileId ||
    v.libraryId !== ref.libraryId ||
    v.hash !== ref.hash
  )
    return;
  return {
    id: v.id,
    blob: v.blob,
    hash: v.hash,
    mime: v.mime,
    width: v.width,
    height: v.height,
  };
}
export async function versionFor(file: LibraryFile) {
  const v = await read<LibraryVersion | undefined>(
    "libraryVersions",
    file.versionId,
  );
  if (!v || v.fileId !== file.id || v.libraryId !== file.libraryId)
    throw new Error("固定versionが欠損しています");
  return v;
}
function cancellation(
  tx: IDBTransaction,
  fail: (e: unknown) => void,
  signal?: AbortSignal,
) {
  const abort = () =>
    fail(new ExecutionError("CANCELLED", "保存を中断しました"));
  signal?.addEventListener("abort", abort, { once: true });
  const detach = () => signal?.removeEventListener("abort", abort);
  tx.addEventListener("complete", detach, { once: true });
  tx.addEventListener("abort", detach, { once: true });
  if (signal?.aborted) {
    abort();
    return false;
  }
  return true;
}
function folderExists(
  tx: IDBTransaction,
  folderId: string | null,
  done: () => void,
  fail: (e: unknown) => void,
) {
  if (!folderId) return done();
  const r = tx.objectStore("libraryFolders").get(folderId);
  r.onsuccess = guarded(fail, () =>
    r.result ? done() : fail(new Error("保存先フォルダがありません")),
  );
}
export async function importLibraryImage(
  file: File,
  folderId: string | null = null,
  signal?: AbortSignal,
): Promise<LibraryRef> {
  signal?.throwIfAborted();
  if (
    file.type &&
    !["image/png", "image/jpeg", "image/webp"].includes(file.type)
  )
    throw new Error("画像MIMEが不正です");
  const asset = await importImage(file);
  if (file.type && file.type !== asset.mime)
    throw new Error("画像MIMEと内容が一致しません");
  signal?.throwIfAborted();
  const originalHash = await sha256(asset.original);
  const version: LibraryVersion = {
    id: crypto.randomUUID(),
    fileId: crypto.randomUUID(),
    libraryId: LIBRARY_ID,
    blob: asset.blob,
    original: asset.original,
    hash: asset.hash,
    mime: "image/png",
    width: asset.width,
    height: asset.height,
    size: asset.blob.size,
    originalHash,
    originalMime: asset.mime as LibraryVersion["originalMime"],
  };
  await validateImage({ ...version, id: version.id }, version.hash);
  let result = libraryRef(version);
  await write(
    ["libraryFiles", "libraryVersions", "libraryFolders"],
    (tx, fail) => {
      if (!cancellation(tx, fail, signal)) return;
      const r = tx.objectStore("libraryVersions").getAll();
      r.onsuccess = guarded(fail, () => {
        const existing = (r.result as LibraryVersion[]).find(
          (v) => v.originalHash === originalHash && v.libraryId === LIBRARY_ID,
        );
        if (existing) {
          result = libraryRef(existing);
          const f = tx.objectStore("libraryFiles").get(existing.fileId);
          f.onsuccess = guarded(fail, () => {
            if (!f.result)
              return fail(new Error("素材metadataが欠損しています"));
            tx.objectStore("libraryFiles").put({ ...f.result, deleted: false });
          });
          return;
        }
        folderExists(
          tx,
          folderId,
          () => {
            tx.objectStore("libraryVersions").add(version);
            tx.objectStore("libraryFiles").add({
              id: version.fileId,
              libraryId: LIBRARY_ID,
              name: file.name.slice(0, 200).trim() || "画像",
              kind: "image",
              versionId: version.id,
              folderId,
              deleted: false,
              createdAt: new Date().toISOString(),
            } satisfies LibraryFile);
          },
          fail,
        );
      });
    },
  );
  return result;
}
export async function updateFile(
  id: string,
  patch: Partial<Pick<LibraryFile, "name" | "folderId" | "deleted">>,
) {
  await write(["libraryFiles", "libraryFolders"], (tx, fail) => {
    const r = tx.objectStore("libraryFiles").get(id);
    r.onsuccess = guarded(fail, () => {
      try {
        if (!r.result) throw new Error("素材がありません");
        const file = libraryFileSchema.parse({ ...r.result, ...patch });
        folderExists(
          tx,
          file.folderId,
          () => tx.objectStore("libraryFiles").put(file),
          fail,
        );
      } catch (e) {
        fail(e);
      }
    });
  });
}
export async function putFolder(value: LibraryFolder) {
  const folder = folderSchema.parse(value);
  await write(["libraryFolders"], (tx, fail) => {
    const r = tx.objectStore("libraryFolders").getAll();
    r.onsuccess = guarded(fail, () => {
      const rows = r.result as LibraryFolder[];
      let id = folder.parentId;
      const seen = new Set([folder.id]);
      while (id) {
        if (seen.has(id))
          return fail(new Error("フォルダを循環して移動できません"));
        seen.add(id);
        const parent = rows.find((f) => f.id === id);
        if (!parent) return fail(new Error("移動先フォルダがありません"));
        id = parent.parentId;
      }
      tx.objectStore("libraryFolders").put(folder);
    });
  });
}
export type SaveReceipt = {
  id: string;
  reference: LibraryRef;
  runId: string;
  nodeId: string;
  attemptId: string;
};
/** Atomic version + receipt publication. History is a separate DB; retry recovers an already committed receipt. */
export async function saveLibraryOutput(
  node: Graph["nodes"][number],
  context: NodeContext,
) {
  const input = context.inputs.image;
  if (input?.type !== "image" || !context.saveIdentity)
    throw new ExecutionError(
      "SAVE_INPUT",
      "保存には画像入力と実行IDが必要です",
    );
  const output = await context.resolver.resolve(
    input.reference,
    context.signal,
  );
  await validateImage(output, input.hash);
  const folderId =
    "folderId" in node.config ? (node.config.folderId ?? null) : null;
  const fingerprint = await sha256(
    new Blob([
      JSON.stringify([
        context.saveIdentity.rootRunId,
        node.id,
        input.hash,
        node.config,
      ]),
    ]),
  );
  const v: LibraryVersion = {
    id: crypto.randomUUID(),
    fileId: crypto.randomUUID(),
    libraryId: LIBRARY_ID,
    blob: output.blob,
    original: output.blob,
    originalHash: output.hash,
    originalMime: output.mime as LibraryVersion["mime"],
    hash: output.hash,
    mime: output.mime as LibraryVersion["mime"],
    size: output.blob.size,
    width: output.width,
    height: output.height,
  };
  let reference = libraryRef(v);
  await write(
    [
      "libraryFiles",
      "libraryVersions",
      "libraryFolders",
      "libraryReceipts",
      "libraryReferences",
    ],
    (tx, fail) => {
      if (!cancellation(tx, fail, context.signal)) return;
      const r = tx.objectStore("libraryReceipts").get(fingerprint);
      r.onsuccess = guarded(fail, () => {
        if (r.result) {
          reference = (r.result as SaveReceipt).reference;
          return;
        }
        folderExists(
          tx,
          folderId,
          () => {
            tx.objectStore("libraryVersions").add(v);
            tx.objectStore("libraryFiles").add({
              id: v.fileId,
              libraryId: LIBRARY_ID,
              kind: "image",
              versionId: v.id,
              folderId,
              deleted: false,
              name:
                ("name" in node.config ? node.config.name.trim() : "") ||
                "加工結果",
              createdAt: new Date().toISOString(),
            } satisfies LibraryFile);
            tx.objectStore("libraryReceipts").add({
              id: fingerprint,
              reference,
              runId: context.saveIdentity!.runId,
              attemptId: context.saveIdentity!.attemptId,
              nodeId: node.id,
            } satisfies SaveReceipt);
            tx.objectStore("libraryReferences").put({
              id: `save:${fingerprint}`,
              reference,
              owner: context.saveIdentity!.runId,
            });
          },
          fail,
        );
      });
    },
  );
  context.signal.throwIfAborted();
  const saved = await lookupLibrary(reference);
  if (!saved)
    throw new ExecutionError("SAVE_MISSING", "保存したversionが見つかりません");
  return { out: imageValue(reference, saved) };
}
/** Append-only pins: no physical deletion API exists in Phase 3. */
export async function pinReferences(owner: string, references: LibraryRef[]) {
  await write(["libraryReferences", "libraryVersions"], (tx, fail) => {
    for (const raw of references) {
      const ref = libraryReferenceSchema.parse(raw);
      const r = tx.objectStore("libraryVersions").get(ref.versionId);
      r.onsuccess = guarded(fail, () => {
        const v = r.result as LibraryVersion | undefined;
        if (
          !v ||
          v.hash !== ref.hash ||
          v.fileId !== ref.fileId ||
          v.libraryId !== ref.libraryId
        )
          return fail(new Error("素材version参照が欠損しています"));
        tx.objectStore("libraryReferences").put({
          id: `${owner}:${ref.versionId}`,
          reference: ref,
          owner,
        });
      });
    }
  });
}
