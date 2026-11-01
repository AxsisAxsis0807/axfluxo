import { sha256 } from "@noble/hashes/sha2.js";
import { md5 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import {
  MiB,
  uploadStartSchema,
  type UploadView,
  type CloudErrorCode,
} from "../../domain/cloud-library/media";
import type { CloudClient } from "./client";
import type { ApiResult } from "../video/api-client";
import { LIMITS } from "../../config/limits";
export class UploadError extends Error {
  constructor(public readonly code: CloudErrorCode | string) {
    super(code);
  }
}
export async function hashBlob(file: Blob, signal?: AbortSignal) {
  const sha = sha256.create(),
    md = md5.create();
  for (let offset = 0; offset < file.size; offset += 2 * MiB) {
    if (signal?.aborted) throw new UploadError("UPLOAD_INTERRUPTED");
    const chunk = new Uint8Array(
      await file
        .slice(offset, Math.min(offset + 2 * MiB, file.size))
        .arrayBuffer(),
    );
    sha.update(chunk);
    md.update(chunk);
  }
  if (signal?.aborted) throw new UploadError("UPLOAD_INTERRUPTED");
  return { sha256: bytesToHex(sha.digest()), md5: bytesToHex(md.digest()) };
}
const resumeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ownerId: z.uuid(),
  key: z.uuid(),
  id: z.uuid().nullable(),
  input: uploadStartSchema,
});
export type ResumeRecord = z.infer<typeof resumeSchema>;
const prefix = "axfluxo-cloud-upload-v1:";
export interface ResumeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  length: number;
  key(index: number): string | null;
}
export function saveResume(storage: ResumeStorage, record: ResumeRecord) {
  try {
    storage.setItem(
      prefix + record.ownerId + ":" + record.key,
      JSON.stringify(resumeSchema.parse(record)),
    );
  } catch {
    throw new UploadError("UPLOAD_INTERRUPTED");
  }
}
export function listResumes(
  storage: ResumeStorage,
  owner: string,
): ResumeRecord[] {
  const result: ResumeRecord[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix + owner + ":")) continue;
      try {
        const parsed = resumeSchema.safeParse(
          JSON.parse(storage.getItem(key) ?? "null"),
        );
        if (parsed.success && parsed.data.ownerId === owner)
          result.push(parsed.data);
      } catch {
        /* Corrupt local hints never authorize an operation. */
      }
    }
  } catch {
    /* Private storage unavailable: new sessions fail before admission. */
  }
  return result;
}
export function removeResume(storage: ResumeStorage, record: ResumeRecord) {
  storage.removeItem(prefix + record.ownerId + ":" + record.key);
}
export function value<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new UploadError(result.code);
  return result.data;
}
/** Explicit selection only. Never accepts a legacy LibraryRef or edits any existing DB. */
export async function uploadFile(options: {
  client: CloudClient;
  file: File;
  ownerId: string;
  folderId: string | null;
  storage: ResumeStorage;
  resume?: ResumeRecord;
  signal?: AbortSignal;
  transport?: typeof fetch;
  onProgress?: (complete: number, total: number) => void;
}): Promise<UploadView> {
  const { file, client, signal, storage } = options;
  if (file.type.startsWith("image/") && file.size > LIMITS.imageBytes)
    throw new UploadError("CORRUPT_MEDIA");
  const identity = value(await client.me());
  if (identity.ownerId !== options.ownerId)
    throw new UploadError("AUTH_REQUIRED");
  const full = await hashBlob(file, signal);
  const record: ResumeRecord = options.resume ?? {
    schemaVersion: 1,
    ownerId: options.ownerId,
    key: crypto.randomUUID(),
    id: null,
    input: uploadStartSchema.parse({
      folderId: options.folderId,
      name: file.name,
      size: file.size,
      mime: file.type,
      sha256: full.sha256,
    }),
  };
  if (
    record.ownerId !== options.ownerId ||
    record.input.sha256 !== full.sha256 ||
    record.input.size !== file.size
  )
    throw new UploadError("UPLOAD_FILE_MISMATCH");
  saveResume(storage, record);
  let status = record.id
    ? value(await client.status(record.id))
    : value(await client.start(record.input, record.key));
  if (status.ownerId !== options.ownerId)
    throw new UploadError("AUTH_REQUIRED");
  record.id = status.id;
  saveResume(storage, record);
  if (["ready", "failed", "verifying"].includes(status.state)) return status;
  if (status.state === "completing")
    return value(await client.complete(status.id));
  if (status.state !== "uploading")
    throw new UploadError(
      status.state === "expired"
        ? "UPLOAD_EXPIRED"
        : status.state === "aborted"
          ? "UPLOAD_ABORTED"
          : "UPLOAD_BUSY",
    );
  let next = 1,
    completed = 0;
  const stop = new AbortController();
  const relay = () => stop.abort();
  signal?.addEventListener("abort", relay, { once: true });
  if (signal?.aborted) stop.abort();
  try {
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (next <= status.partCount) {
          const number = next++,
            start = (number - 1) * status.partSize,
            blob = file.slice(
              start,
              Math.min(file.size, start + status.partSize),
            ),
            hash = await hashBlob(blob, stop.signal);
          const previous = status.parts.find((p) => p.number === number);
          if (
            previous &&
            (previous.sha256 !== hash.sha256 ||
              previous.md5 !== hash.md5 ||
              previous.size !== blob.size)
          )
            throw new UploadError("UPLOAD_FILE_MISMATCH");
          if (!previous?.etag) {
            const signed = value(
              await client.sign(status.id, {
                number,
                size: blob.size,
                ...hash,
              }),
            );
            if (stop.signal.aborted)
              throw new UploadError("UPLOAD_INTERRUPTED");
            let response: Response;
            try {
              response = await (options.transport ?? fetch)(signed.url, {
                method: "PUT",
                headers: signed.headers,
                body: blob,
                signal: stop.signal,
                credentials: "omit",
                redirect: "error",
              });
            } catch {
              throw new UploadError("UPLOAD_INTERRUPTED");
            }
            if (response.status === 403)
              throw new UploadError("UPLOAD_SIGNATURE_EXPIRED");
            if (!response.ok) throw new UploadError("UPLOAD_INTERRUPTED");
            const etag = response.headers
              .get("etag")
              ?.replaceAll('"', "")
              .toLowerCase();
            if (etag !== hash.md5)
              throw new UploadError("UPLOAD_PART_MISMATCH");
          }
          options.onProgress?.(++completed, status.partCount);
        }
      }).map((p) =>
        p.catch((error) => {
          stop.abort();
          throw error;
        }),
      ),
    );
    if (stop.signal.aborted) throw new UploadError("UPLOAD_INTERRUPTED");
    status = value(await client.complete(status.id));
    return status;
  } finally {
    signal?.removeEventListener("abort", relay);
  }
}
export const cloudErrorMessage: Record<string, string> = {
  FOLDER_CYCLE: "folderを自身または子孫へ移動できません。",
  SYSTEM_FOLDER: "初期folderは移動できません。",
  HTTP_403: "開発者権限を確認できません。",
  AUTH_EXPIRED:
    "ログインの期限が切れました。再ログイン後に同じファイルを選び直してください。",
  AUTH_REQUIRED: "ログインしてください。",
  UPLOAD_INTERRUPTED:
    "転送を一時停止しました。同じファイルを選び直して再開できます。",
  QUOTA_EXCEEDED: "保存容量の予約上限を超えています。",
  QUOTA_UNCONFIGURED: "保存容量の上限が未設定のため受付を停止しています。",
  UPLOADS_DISABLED: "新規uploadは停止中です。",
  UPLOAD_SIGNATURE_EXPIRED:
    "part署名の期限が切れました。同じファイルを選び直して再開してください。",
  UPLOAD_FILE_MISMATCH: "選択したファイルの内容が元のファイルと一致しません。",
  UPLOAD_PART_MISMATCH:
    "part検証に失敗しました。同じファイルで再試行してください。",
  HASH_MISMATCH: "原本のSHA-256が一致しません。素材は公開されていません。",
  SIZE_MISMATCH: "原本サイズの検証に失敗しました。",
  MIME_MISMATCH: "申告された形式と実際の素材形式が一致しません。",
  CORRUPT_MEDIA: "素材が破損しているか、画像上限を超えています。",
  CODEC_UNSUPPORTED: "このcodecには対応していません。",
  UPLOAD_EXPIRED: "未完了uploadの保持期限が切れました。",
  UPLOAD_ABORTED: "未完了uploadを中止しました。",
  UPLOAD_ALREADY_COMPLETED:
    "確定原本は保持されます。この操作では削除できません。",
  UPLOAD_BUSY: "upload状態を確認中です。しばらくして再確認してください。",
  STORAGE_UNAVAILABLE:
    "原本ストレージを確認できません。時間をおいて再試行してください。",
};
