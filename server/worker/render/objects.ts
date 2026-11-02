import { randomUUID, createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Database, Row } from "../../db/database";
import type { MultipartStorage } from "../../storage/multipart";
import { fenced, type Claim } from "../jobs/queue";
import { RenderError, storageError } from "../jobs/errors";
import { fileHash } from "./process";
export type RenderStorage = MultipartStorage & {
  putRender: NonNullable<MultipartStorage["putRender"]>;
};
export async function download(
  storage: MultipartStorage,
  key: string,
  path: string,
  size: number,
  hash: string,
  signal?: AbortSignal,
) {
  const h = createHash("sha256");
  let count = 0;
  try {
    const head = await storage.head(key);
    if (!head) throw new RenderError("INPUT_MISSING");
    if (head.size !== size) throw new RenderError("INPUT_CORRUPT");
    const stream = await storage.stream(key, signal);
    async function* checked() {
      for await (const b of stream) {
        signal?.throwIfAborted();
        count += b.byteLength;
        if (count > size) throw new RenderError("INPUT_CORRUPT");
        h.update(b);
        yield b;
      }
    }
    await pipeline(
      checked(),
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
      { signal },
    );
  } catch (e) {
    if (e instanceof RenderError) throw e;
    if (signal?.aborted) throw new RenderError("LEASE_LOST");
    throw storageError(e);
  }
  if (count !== size || h.digest("hex") !== hash)
    throw new RenderError("INPUT_CORRUPT");
}
export async function storeObject(
  db: Database,
  storage: RenderStorage,
  c: Claim,
  p: {
    path: string;
    hash: string;
    size: number;
    kind: "segment" | "candidate" | "output";
    planHash: string;
    index?: number;
  },
  signal?: AbortSignal,
): Promise<Row> {
  const id = randomUUID(),
    key = `render-${p.kind === "output" ? "outputs" : "staging"}/${c.owner}/${c.job}/${id}.mp4`;
  const row = await fenced(db, c, async (sql) => {
    // All retained candidates/checkpoints are charged, including abandoned objects.
    const q = await sql.query(
      "UPDATE axfluxo_video.media_quotas SET reserved_bytes=reserved_bytes+$2::bigint WHERE owner_id=$1 AND NOT blocked AND limit_bytes IS NOT NULL AND $2::bigint<=limit_bytes-reserved_bytes-used_bytes RETURNING owner_id",
      [c.owner, p.size],
    );
    if (!q.rows.length) throw new RenderError("QUOTA_EXCEEDED");
    return (
      await sql.query(
        storage.renderNamespace
          ? "INSERT INTO axfluxo_video.render_objects(id,owner_id,job_id,object_key,hash,size,kind,segment_index,plan_hash,storage_namespace) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *"
          : "INSERT INTO axfluxo_video.render_objects(id,owner_id,job_id,object_key,hash,size,kind,segment_index,plan_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [
          id,
          c.owner,
          c.job,
          key,
          p.hash,
          p.size,
          p.kind,
          p.index ?? null,
          p.planHash,
          ...(storage.renderNamespace ? [storage.renderNamespace] : []),
        ],
      )
    ).rows[0];
  });
  const remote =
    storage.forRenderObject?.(storage.renderNamespace ?? "legacy") ?? storage;
  try {
    await storage.putRender(key, p.path, p.size, "video/mp4", p.hash);
  } catch (error) {
    // A lost PUT/complete response may already have committed immutable bytes.
    try {
      if ((await remote.head(key))?.size !== p.size) throw new Error();
    } catch {
      throw storageError(error);
    }
  }
  // Verify real remote bytes, not ETag or client metadata. Never publish on partial upload.
  const h = createHash("sha256");
  let size = 0;
  try {
    for await (const b of await remote.stream(key, signal)) {
      signal?.throwIfAborted();
      size += b.byteLength;
      if (size > p.size) throw new RenderError("VALIDATION_FAILED");
      h.update(b);
    }
  } catch (error) {
    if (signal?.aborted) throw new RenderError("LEASE_LOST");
    if (error instanceof RenderError) throw error;
    throw storageError(error);
  }
  if (size !== p.size || h.digest("hex") !== p.hash)
    throw new RenderError("VALIDATION_FAILED");
  await fenced(db, c, async (sql) => {
    await sql.query(
      "UPDATE axfluxo_video.render_objects SET ready=true WHERE owner_id=$1 AND id=$2 AND NOT ready",
      [c.owner, id],
    );
    await sql.query(
      "UPDATE axfluxo_video.media_quotas SET reserved_bytes=reserved_bytes-$2::bigint,used_bytes=used_bytes+$2::bigint WHERE owner_id=$1",
      [c.owner, p.size],
    );
  });
  if ((await fileHash(p.path)) !== p.hash)
    throw new RenderError("VALIDATION_FAILED");
  return { ...row, ready: true };
}
