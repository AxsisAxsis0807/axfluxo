import {
  driveUploadView,
  type DriveUploadView,
} from "../../domain/drive-cloud/schema";
import { sha256File } from "../../domain/cloud-export/sha256";
import type { createVideoApiClient } from "./api-client";
export type DriveClient = ReturnType<typeof createVideoApiClient>;
export type TransferMemo = {
  owner: string;
  sha256: string;
  size: number;
  id: string;
  operation: string;
};
/** Separate additive recovery DB. No OAuth token/session URL/file body is stored here. */
export async function transferMemo(
  owner: string,
  hash: string,
  value?: TransferMemo,
): Promise<TransferMemo | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("axfluxo-drive-transfers", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("transfers");
    open.onerror = () => reject(Error("DRIVE_RECOVERY_UNAVAILABLE"));
    open.onsuccess = () => {
      const db = open.result,
        tx = db.transaction("transfers", value ? "readwrite" : "readonly"),
        store = tx.objectStore("transfers"),
        key = owner + ":" + hash;
      let result: TransferMemo | undefined;
      if (value) store.put(value, key);
      else {
        const get = store.get(key);
        get.onsuccess = () => {
          result = get.result;
        };
      }
      tx.oncomplete = () => {
        db.close();
        resolve(value ?? result);
      };
      tx.onabort = () => {
        db.close();
        reject(Error("DRIVE_RECOVERY_UNAVAILABLE"));
      };
    };
  });
}
function unwrap<T>(
  result: { ok: true; data: T } | { ok: false; code: string },
): T {
  if (!result.ok) throw Error(result.code);
  return result.data;
}
/** One bounded chunk at a time. Server/Google status, never local offset, determines resumption. */
export async function uploadDriveFile(
  client: DriveClient,
  owner: string,
  file: File,
  onProgress: (offset: number, total: number) => void,
  signal?: AbortSignal,
) {
  const hash = await sha256File(file);
  signal?.throwIfAborted();
  let memo = await transferMemo(owner, hash);
  let status: DriveUploadView;
  if (memo && memo.size === file.size && memo.id)
    status = unwrap(
      await client.request("/v1/drive/uploads/" + memo.id, driveUploadView),
    );
  else {
    const operation = memo?.operation ?? crypto.randomUUID();
    await transferMemo(owner, hash, {
      owner,
      sha256: hash,
      size: file.size,
      id: "",
      operation,
    });
    status = unwrap(
      await client.request(
        "/v1/drive/uploads",
        driveUploadView,
        "POST",
        {
          size: file.size,
          sha256: hash,
          mime: file.type || mimeByExtension(file.name),
          name: file.name,
        },
        operation,
      ),
    );
    memo = { owner, sha256: hash, size: file.size, id: status.id, operation };
    await transferMemo(owner, hash, memo);
  }
  if (status.sha256 !== hash || status.size !== file.size)
    throw Error("DRIVE_RESELECT_MISMATCH");
  if (status.state === "held")
    status = unwrap(
      await client.request(
        "/v1/drive/uploads/" + status.id + "/resume",
        driveUploadView,
        "POST",
        {},
        crypto.randomUUID(),
      ),
    );
  status = unwrap(
    await client.request("/v1/drive/uploads/" + status.id, driveUploadView),
  );
  while (status.state === "uploading") {
    signal?.throwIfAborted();
    const offset = status.offset;
    const bytes = new Uint8Array(
      await file
        .slice(offset, Math.min(file.size, offset + 4194304))
        .arrayBuffer(),
    );
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes),
      partHash = Array.from(new Uint8Array(hashBuffer), (v) =>
        v.toString(16).padStart(2, "0"),
      ).join("");
    status = unwrap(
      await client.bytes(
        `/v1/drive/uploads/${status.id}/chunks/${offset}/${partHash}`,
        bytes,
        driveUploadView,
        signal,
      ),
    );
    onProgress(status.offset, file.size);
    if (status.state === "uploading" && status.offset <= offset)
      throw Error("DRIVE_RETRY_LATER");
  }
  return status;
}

function mimeByExtension(name: string) {
  const known: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };
  return (
    known[name.split(".").at(-1)?.toLowerCase() ?? ""] ??
    "application/octet-stream"
  );
}
