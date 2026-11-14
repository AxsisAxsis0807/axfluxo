import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { MultipartStorage } from "../storage/multipart";
import type { ObjectReader, RenderStorage } from "../worker/render/objects";
import { ApiError } from "../api/errors";
import type { DriveCloud, Inventory } from "./service";
import { DRIVE_CHUNK } from "./transfer";
export function driveRenderStorage(
  service: DriveCloud,
  owner: string,
  job: string,
  fallback: MultipartStorage | null,
): RenderStorage {
  const find = async (key: string) =>
    service.owner(
      owner,
      async (sql) =>
        (
          await sql.query<Inventory>(
            "SELECT i.* FROM axfluxo_video.drive_inventory i WHERE i.owner_id=$1 AND (i.object_key=$2 OR (i.namespace='original' AND i.version_id IN (SELECT id FROM axfluxo_video.media_versions WHERE owner_id=$1 AND object_key=$2)))",
            [owner, key],
          )
        ).rows[0],
    );
  const reader: ObjectReader = {
    async head(key) {
      const row = await find(key);
      if (!row) {
        if (key.startsWith("drive:"))
          throw new ApiError(404, "DRIVE_RESOURCE_MISSING");
        return fallback?.head(key) ?? null;
      }
      await service.remoteIdentity(owner, row);
      return { size: Number(row.size) };
    },
    async stream(key, signal) {
      const row = await find(key);
      if (!row) {
        if (key.startsWith("drive:") || !fallback)
          throw new ApiError(404, "DRIVE_RESOURCE_MISSING");
        return fallback.stream(key, signal);
      }
      const identity = await service.remoteIdentity(owner, row);
      return (
        await service
          .transfer(owner)
          .stream(row.file_id!, signal, undefined, identity.revisionId)
      ).body;
    },
  };
  return {
    ...reader,
    renderNamespace: "drive-v1",
    quotaManaged: true,
    forRenderObject(namespace) {
      if (namespace === "drive-v1") return reader;
      if (!fallback) throw new ApiError(409, "DRIVE_LEGACY_UNAVAILABLE");
      return fallback.forRenderObject?.(namespace) ?? fallback;
    },
    async putRender(key, path, size, mime, hash, signal) {
      const match =
        /^render-(staging|outputs)\/([a-f0-9-]+)\/([a-f0-9-]+)\/([a-f0-9-]+)\.mp4$/.exec(
          key,
        );
      if (!match || match[2] !== owner || match[3] !== job)
        throw new ApiError(403, "DRIVE_IDENTITY_MISMATCH");
      const object = await service.owner(
        owner,
        async (sql) =>
          (
            await sql.query(
              "SELECT kind FROM axfluxo_video.render_objects WHERE owner_id=$1 AND job_id=$2 AND object_key=$3 AND hash=$4 AND size=$5",
              [owner, job, key, hash, size],
            )
          ).rows[0],
      );
      if (!object) throw new ApiError(403, "DRIVE_IDENTITY_MISMATCH");
      const reserved = await service.reserve(owner, {
        key,
        size,
        hash,
        mime,
        name: match[4] + ".mp4",
        namespace: String(object.kind),
        job,
        objectKey: key,
      });
      await writeDriveObject(service, owner, reserved, path, signal);
    },
  };
}

export async function writeDriveObject(
  service: DriveCloud,
  owner: string,
  reserved: Inventory,
  path: string,
  signal?: AbortSignal,
) {
  const size = Number(reserved.size),
    hash = reserved.hash;
  if (reserved.state === "ready") {
    await service.remoteIdentity(owner, reserved);
    return;
  }
  const { row, token } = await service.lease(owner, reserved.id);
  const stop = new AbortController();
  signal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const timer = setInterval(() => {
    void service
      .update(owner, row.id, token, "lease_until=now()+interval '5 minutes'")
      .catch(() => stop.abort());
  }, 15000);
  try {
    let current = await service.reconcile(owner, row, token);
    const file = await open(path, "r");
    try {
      while (current.state === "uploading") {
        signal?.throwIfAborted();
        const offset = Number(current.offset_bytes),
          length = Math.min(DRIVE_CHUNK, size - offset),
          buffer = Buffer.alloc(length);
        const read = await file.read(buffer, 0, length, offset);
        if (read.bytesRead !== length)
          throw new ApiError(422, "DRIVE_INTEGRITY_FAILED");
        await service.event(owner, "upload", length);
        const result = await service
          .transfer(owner)
          .session(
            service.google.config.vault.open(
              current.session_cipher!,
              owner + ":upload:" + row.id,
            ),
            size,
            buffer,
            offset,
            signal,
          );
        if (result.expired) throw new ApiError(409, "DRIVE_SESSION_EXPIRED");
        if (result.offset <= offset)
          throw new ApiError(503, "DRIVE_RETRY_LATER");
        current = await service.update(
          owner,
          row.id,
          token,
          "offset_bytes=$4,state=CASE WHEN $5 THEN 'verifying' ELSE 'uploading' END,lease_until=now()+interval '5 minutes'",
          [result.offset, result.complete],
        );
      }
    } finally {
      await file.close();
    }
    const before = await service.remoteIdentity(owner, current),
      h = createHash("sha256");
    let count = 0;
    for await (const b of (
      await service
        .transfer(owner)
        .stream(current.file_id!, signal, undefined, before.revisionId)
    ).body) {
      count += b.length;
      if (count > size) throw new ApiError(422, "DRIVE_INTEGRITY_FAILED");
      h.update(b);
    }
    await service.event(owner, "download", count);
    if (count !== size || h.digest("hex") !== hash)
      throw new ApiError(422, "DRIVE_INTEGRITY_FAILED");
    const after = await service.remoteIdentity(owner, current);
    if (before.version !== after.version)
      throw new ApiError(409, "DRIVE_IDENTITY_MISMATCH");
    await service.owner(owner, async (sql) => {
      const r = await sql.query(
        "UPDATE axfluxo_video.drive_inventory SET state='ready',verified_at=now(),remote_version=$4,remote_revision=$5 WHERE owner_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>now() AND state<>'ready' RETURNING id",
        [owner, row.id, token, after.version, after.revisionId],
      );
      if (!r.rows.length) throw new ApiError(409, "DRIVE_LEASE_LOST");
      await sql.query(
        "UPDATE axfluxo_video.drive_capacity SET used_bytes=used_bytes+$2::bigint,reserved_bytes=reserved_bytes-$2::bigint WHERE owner_id=$1",
        [owner, size],
      );
    });
  } finally {
    clearInterval(timer);
    stop.abort();
    await service.release(owner, row.id, token);
  }
}
