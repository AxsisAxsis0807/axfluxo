import { createHash } from "node:crypto";
import type { Database, Row, Sql } from "../db/database";
import { ApiError } from "../api/errors";
import {
  exportLimits,
  type ExportBlobKind,
  type ExportBlobView,
} from "../../src/domain/cloud-export/schema";

export type BlobRow = Row & {
  id: string;
  owner_id: string;
  kind: ExportBlobKind | "output";
  size: string | number;
  sha256: string;
  chunk_size: string | number;
  chunk_count: number;
  state: "pending" | "ready";
};

/** Every statement runs with the owner scope used by the export RLS policies. */
export function exportScoped<T>(
  db: Database,
  owner: string,
  work: (sql: Sql) => Promise<T>,
): Promise<T> {
  return db.transaction(async (sql) => {
    await sql.query("SELECT set_config('axfluxo.export_owner',$1,true)", [
      owner,
    ]);
    return work(sql);
  });
}

export async function requireExportMembership(sql: Sql, owner: string) {
  const result = await sql.query(
    "SELECT owner_id FROM axfluxo_video.developer_memberships WHERE owner_id=$1 AND active AND (expires_at IS NULL OR expires_at>now()) FOR SHARE",
    [owner],
  );
  if (result.rows.length !== 1) throw new ApiError(403, "DEVELOPER_REQUIRED");
}

export const blobView = (row: BlobRow): ExportBlobView => ({
  id: row.id,
  kind: row.kind === "image" ? "image" : "video",
  size: Number(row.size),
  sha256: row.sha256,
});

/** Layout is derived from the declared size; a client cannot choose chunk boundaries. */
export function blobLayout(size: number) {
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new ApiError(400, "EXPORT_LIMIT_EXCEEDED");
  const chunkSize = exportLimits.chunkBytes;
  return { chunkSize, chunkCount: Math.ceil(size / chunkSize) };
}

export async function beginBlob(
  db: Database,
  owner: string,
  input: { id: string; kind: ExportBlobKind; size: number; sha256: string },
): Promise<{ duplicate: ExportBlobView | null }> {
  const { chunkSize, chunkCount } = blobLayout(input.size);
  return exportScoped(db, owner, async (sql) => {
    const existing = await sql.query<BlobRow>(
      "SELECT * FROM axfluxo_export.blobs WHERE owner_id=$1 AND sha256=$2 AND kind=$3 AND size=$4 AND state='ready'",
      [owner, input.sha256, input.kind, input.size],
    );
    if (existing.rows.length) return { duplicate: blobView(existing.rows[0]) };
    try {
      await sql.query(
        "INSERT INTO axfluxo_export.blobs(id,owner_id,kind,size,sha256,chunk_size,chunk_count) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          input.id,
          owner,
          input.kind,
          input.size,
          input.sha256,
          chunkSize,
          chunkCount,
        ],
      );
    } catch (error) {
      // A concurrent identical upload may have won the unique key.
      if ((error as { code?: string }).code !== "23505") throw error;
      const again = await sql.query<BlobRow>(
        "SELECT * FROM axfluxo_export.blobs WHERE owner_id=$1 AND sha256=$2 AND kind=$3 AND size=$4 AND state='ready'",
        [owner, input.sha256, input.kind, input.size],
      );
      if (again.rows.length) return { duplicate: blobView(again.rows[0]) };
      throw new ApiError(409, "EXPORT_BUSY");
    }
    return { duplicate: null };
  });
}

export async function appendBlobChunk(
  db: Database,
  owner: string,
  blobId: string,
  ordinal: number,
  data: Uint8Array,
) {
  await exportScoped(db, owner, async (sql) => {
    await sql.query(
      "INSERT INTO axfluxo_export.blob_chunks(blob_id,ordinal,byte_length,data) VALUES($1,$2,$3,$4)",
      [blobId, ordinal, data.byteLength, Buffer.from(data)],
    );
  });
}

export async function finalizeBlob(
  db: Database,
  owner: string,
  input: { id: string; size: number; sha256: string },
): Promise<ExportBlobView> {
  return exportScoped(db, owner, async (sql) => {
    const row = (
      await sql.query<BlobRow>(
        "SELECT * FROM axfluxo_export.blobs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, input.id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "EXPORT_NOT_FOUND");
    if (Number(row.size) !== input.size || row.sha256 !== input.sha256)
      throw new ApiError(409, "EXPORT_HASH_MISMATCH");
    if (row.state === "ready") return blobView(row);
    const counted = (
      await sql.query<{ total: string | number; chunks: string | number }>(
        "SELECT coalesce(sum(byte_length),0) AS total, count(*) AS chunks FROM axfluxo_export.blob_chunks WHERE blob_id=$1",
        [input.id],
      )
    ).rows[0];
    if (
      Number(counted.total) !== input.size ||
      Number(counted.chunks) !== row.chunk_count
    )
      throw new ApiError(409, "EXPORT_BLOB_INCOMPLETE");
    await sql.query(
      "UPDATE axfluxo_export.blobs SET state='ready' WHERE owner_id=$1 AND id=$2 AND state='pending'",
      [owner, input.id],
    );
    return blobView(row);
  });
}

/** Removes an incomplete upload. Ready bytes are write-once and cannot be deleted here. */
export async function discardBlob(db: Database, owner: string, id: string) {
  await exportScoped(db, owner, async (sql) => {
    const row = (
      await sql.query<BlobRow>(
        "SELECT state FROM axfluxo_export.blobs WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    if (!row || row.state !== "pending") return;
    await sql.query(
      "DELETE FROM axfluxo_export.blob_chunks WHERE blob_id=$1",
      [id],
    );
    await sql.query(
      "DELETE FROM axfluxo_export.blobs WHERE owner_id=$1 AND id=$2 AND state='pending'",
      [owner, id],
    );
  });
}

export async function blobForOwner(
  db: Database,
  owner: string,
  id: string,
): Promise<BlobRow> {
  return exportScoped(db, owner, async (sql) => {
    const row = (
      await sql.query<BlobRow>(
        "SELECT * FROM axfluxo_export.blobs WHERE owner_id=$1 AND id=$2 AND state='ready'",
        [owner, id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "EXPORT_NOT_FOUND");
    return row;
  });
}

/**
 * Streams verified bytes with bounded memory: one chunk row per transaction.
 * The caller must already have established that the blob belongs to the owner.
 */
export async function* readBlob(
  db: Database,
  owner: string,
  row: BlobRow,
  range?: { start: number; end: number },
): AsyncGenerator<Uint8Array> {
  const chunkSize = Number(row.chunk_size),
    size = Number(row.size);
  const start = range?.start ?? 0,
    end = range?.end ?? size;
  if (!(0 <= start && start < end && end <= size))
    throw new ApiError(416, "EXPORT_LIMIT_EXCEEDED");
  const first = Math.floor(start / chunkSize),
    last = Math.floor((end - 1) / chunkSize);
  for (let ordinal = first; ordinal <= last; ordinal++) {
    const chunk = await exportScoped(db, owner, async (sql) => {
      const value = (
        await sql.query<{ data: Uint8Array }>(
          "SELECT data FROM axfluxo_export.blob_chunks WHERE blob_id=$1 AND ordinal=$2",
          [row.id, ordinal],
        )
      ).rows[0];
      return value?.data;
    });
    if (!chunk) throw new ApiError(409, "EXPORT_BLOB_INCOMPLETE");
    const from = ordinal === first ? start - ordinal * chunkSize : 0;
    const to =
      ordinal === last ? end - ordinal * chunkSize : chunk.byteLength;
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (to > bytes.byteLength)
      throw new ApiError(409, "EXPORT_BLOB_INCOMPLETE");
    yield from === 0 && to === bytes.byteLength
      ? bytes
      : bytes.subarray(from, to);
  }
}

export async function storeBlob(
  db: Database,
  owner: string,
  input: {
    id: string;
    kind: "output";
    sha256: string;
    chunks: AsyncIterable<Uint8Array>;
    size: number;
  },
) {
  const { chunkSize, chunkCount } = blobLayout(input.size);
  const inserted = await exportScoped(db, owner, (sql) =>
    sql.query<{ id: string }>(
      "INSERT INTO axfluxo_export.blobs(id,owner_id,kind,size,sha256,chunk_size,chunk_count) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (owner_id,sha256,kind,size) DO NOTHING RETURNING id",
      [
        input.id,
        owner,
        input.kind,
        input.size,
        input.sha256,
        chunkSize,
        chunkCount,
      ],
    ),
  );
  if (!inserted.rows.length) {
    const existing = await exportScoped(db, owner, async (sql) =>
      (
        await sql.query<{ id: string }>(
          "SELECT id FROM axfluxo_export.blobs WHERE owner_id=$1 AND sha256=$2 AND kind=$3 AND size=$4 AND state='ready'",
          [owner, input.sha256, input.kind, input.size],
        )
      ).rows[0],
    );
    if (!existing) throw new ApiError(409, "EXPORT_BUSY");
    return existing.id;
  }
  let ordinal = 0,
    received = 0;
  const hash = createHash("sha256");
  for await (const chunk of input.chunks) {
    if (chunk.byteLength > chunkSize)
      throw new ApiError(409, "EXPORT_OUTPUT_INVALID");
    hash.update(chunk);
    received += chunk.byteLength;
    if (received > input.size)
      throw new ApiError(409, "EXPORT_OUTPUT_INVALID");
    await appendBlobChunk(db, owner, input.id, ordinal++, chunk);
  }
  if (received !== input.size || hash.digest("hex") !== input.sha256)
    throw new ApiError(409, "EXPORT_HASH_MISMATCH");
  await exportScoped(db, owner, (sql) =>
    sql.query(
      "UPDATE axfluxo_export.blobs SET state='ready' WHERE owner_id=$1 AND id=$2 AND state='pending'",
      [owner, input.id],
    ),
  );
  return input.id;
}
