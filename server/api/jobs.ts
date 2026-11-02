import { executionSnapshot } from "../contracts/snapshot";
import { createHash, randomUUID } from "node:crypto";
import { type FnfSnapshot } from "../../src/domain/video/schema";
import { toFrame } from "../../src/domain/video/time";
import {
  batchViewSchema,
  jobViewSchema,
  type BatchView,
  type JobView,
} from "../contracts/video";
import type { Sql } from "../db/database";
import { ApiError } from "./errors";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export async function requireMembership(sql: Sql, owner: string) {
  await sql.query("SELECT set_config('axfluxo.owner_id', $1, true)", [owner]);
  const result = await sql.query(
    "SELECT owner_id FROM axfluxo_video.developer_memberships WHERE owner_id=$1 AND active AND (expires_at IS NULL OR expires_at > now()) FOR SHARE",
    [owner],
  );
  if (result.rows.length !== 1) throw new ApiError(403, "DEVELOPER_REQUIRED");
}
export async function idempotent(
  sql: Sql,
  owner: string,
  key: string,
  hash: string,
  work: () => Promise<{ status: number; body: unknown }>,
) {
  await sql.query(
    "INSERT INTO axfluxo_video.idempotency_requests(owner_id,idempotency_key,request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [owner, key, hash],
  );
  const { rows } = await sql.query(
    "SELECT request_hash,response,response_status FROM axfluxo_video.idempotency_requests WHERE owner_id=$1 AND idempotency_key=$2 FOR UPDATE",
    [owner, key],
  );
  if (rows[0].request_hash !== hash)
    throw new ApiError(409, "IDEMPOTENCY_CONFLICT");
  if (rows[0].response !== null)
    return { status: Number(rows[0].response_status), body: rows[0].response };
  const result = await work();
  await sql.query(
    "UPDATE axfluxo_video.idempotency_requests SET response=$3::jsonb,response_status=$4 WHERE owner_id=$1 AND idempotency_key=$2",
    [owner, key, JSON.stringify(result.body), result.status],
  );
  return result;
}
function cost(
  snapshot: FnfSnapshot,
  index: number,
  unitsPerFrame: number | undefined,
): bigint {
  if (
    !Number.isSafeInteger(unitsPerFrame) ||
    !unitsPerFrame ||
    unitsPerFrame < 1 ||
    unitsPerFrame > 1_000_000
  )
    throw new ApiError(503, "BUDGET_UNCONFIGURED");
  const range = snapshot.ranges[index];
  return (
    BigInt(toFrame(range.endUs) - toFrame(range.startUs)) *
    BigInt(unitsPerFrame)
  );
}
async function reserve(sql: Sql, owner: string, units: bigint) {
  const { rows } = await sql.query(
    "SELECT limit_units FROM axfluxo_video.usage_budgets WHERE owner_id=$1 FOR UPDATE",
    [owner],
  );
  if (rows.length !== 1 || rows[0].limit_units === null)
    throw new ApiError(503, "BUDGET_UNCONFIGURED");
  if (units > 9_223_372_036_854_775_807n)
    throw new ApiError(409, "BUDGET_EXCEEDED");
  const result = await sql.query(
    "UPDATE axfluxo_video.usage_budgets SET reserved_units=reserved_units+$2::bigint WHERE owner_id=$1 AND $2::bigint <= limit_units-reserved_units-consumed_units RETURNING owner_id",
    [owner, units.toString()],
  );
  if (result.rows.length !== 1) throw new ApiError(409, "BUDGET_EXCEEDED");
}
async function checkResources(sql: Sql, owner: string, snapshot: FnfSnapshot) {
  for (const clip of snapshot.document.clips) {
    const r = clip.source;
    const result = await sql.query(
      "SELECT version_id FROM axfluxo_video.resource_versions WHERE owner_id=$1 AND library_id=$2 AND file_id=$3 AND version_id=$4 AND hash=$5 AND kind=$6",
      [owner, r.libraryId, r.fileId, r.versionId, r.hash, r.kind],
    );
    if (result.rows.length !== 1) throw new ApiError(404, "RESOURCE_NOT_FOUND");
  }
}
async function createJob(
  sql: Sql,
  owner: string,
  batchId: string,
  snapshot: FnfSnapshot,
  index: number,
  attempt: number,
  retryOf: string | null,
  units: bigint,
): Promise<JobView> {
  const id = randomUUID();
  await sql.query(
    "INSERT INTO axfluxo_video.render_jobs(id,owner_id,batch_id,range_index,attempt,retry_of) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, owner, batchId, index, attempt, retryOf],
  );
  await sql.query(
    "INSERT INTO axfluxo_video.usage_reservations(id,owner_id,job_id,units) VALUES ($1,$2,$3,$4)",
    [randomUUID(), owner, id, units.toString()],
  );
  for (const clip of snapshot.document.clips) {
    const r = clip.source;
    await sql.query(
      "INSERT INTO axfluxo_video.resource_pins(id,owner_id,job_id,library_id,file_id,version_id,hash,kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (owner_id,job_id,library_id,file_id,version_id) DO NOTHING",
      [
        randomUUID(),
        owner,
        id,
        r.libraryId,
        r.fileId,
        r.versionId,
        r.hash,
        r.kind,
      ],
    );
  }
  await sql.query(
    "INSERT INTO axfluxo_video.outbox_events(id,owner_id,job_id,event_type) VALUES ($1,$2,$3,'render.requested')",
    [randomUUID(), owner, id],
  );
  return { id, state: "queued", rangeIndex: index, attempt, retryOf };
}
export async function createBatch(
  sql: Sql,
  owner: string,
  snapshot: FnfSnapshot,
  unitsPerFrame?: number,
): Promise<BatchView> {
  await capacityGuard(sql, owner);
  await checkResources(sql, owner, snapshot);
  const costs = snapshot.ranges.map((_, i) => cost(snapshot, i, unitsPerFrame));
  await reserve(
    sql,
    owner,
    costs.reduce((sum, n) => sum + n, 0n),
  );
  const id = randomUUID();
  await sql.query(
    "INSERT INTO axfluxo_video.render_batches(id,owner_id,snapshot,snapshot_hash) VALUES ($1,$2,$3::jsonb,$4)",
    [id, owner, JSON.stringify(snapshot), digest(snapshot)],
  );
  const jobs: JobView[] = [];
  for (let i = 0; i < costs.length; i++)
    jobs.push(await createJob(sql, owner, id, snapshot, i, 1, null, costs[i]));
  await sql.query(
    "INSERT INTO axfluxo_video.audit_events(id,owner_id,action,batch_id) VALUES ($1,$2,'batch.created',$3)",
    [randomUUID(), owner, id],
  );
  return { id, ownerId: owner, jobs, outputs: [] };
}
const jobColumns = `id,state,range_index AS "rangeIndex",attempt,retry_of AS "retryOf"`;
export async function getBatch(
  sql: Sql,
  owner: string,
  id: string,
): Promise<BatchView> {
  const found = await sql.query(
    "SELECT id FROM axfluxo_video.render_batches WHERE owner_id=$1 AND id=$2",
    [owner, id],
  );
  if (found.rows.length !== 1) throw new ApiError(404, "NOT_FOUND");
  const jobs = await sql.query(
    `SELECT ${jobColumns} FROM axfluxo_video.render_jobs WHERE owner_id=$1 AND batch_id=$2 ORDER BY range_index,attempt`,
    [owner, id],
  );
  const outputs = await sql.query(
    `SELECT o.id,o.job_id AS "jobId",jsonb_build_object('libraryId',o.library_id,'fileId',o.file_id,'versionId',o.version_id,'hash',o.hash,'kind',o.kind) AS reference FROM axfluxo_video.render_outputs o JOIN axfluxo_video.render_jobs j ON j.owner_id=o.owner_id AND j.id=o.job_id WHERE o.owner_id=$1 AND j.batch_id=$2 ORDER BY j.range_index,j.attempt`,
    [owner, id],
  );
  return batchViewSchema.parse({
    id,
    ownerId: owner,
    jobs: jobs.rows,
    outputs: outputs.rows,
  });
}
export async function retryJob(
  sql: Sql,
  owner: string,
  id: string,
  unitsPerFrame?: number,
) {
  const { rows } = await sql.query(
    `SELECT ${jobColumns},batch_id FROM axfluxo_video.render_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
    [owner, id],
  );
  if (!rows.length) throw new ApiError(404, "NOT_FOUND");
  const row = rows[0];
  if (!["failed", "cancelled", "interrupted"].includes(String(row.state)))
    throw new ApiError(409, "JOB_NOT_RETRYABLE");
  const existing = await sql.query(
    "SELECT id FROM axfluxo_video.render_jobs WHERE owner_id=$1 AND retry_of=$2",
    [owner, id],
  );
  if (existing.rows.length) throw new ApiError(409, "JOB_ALREADY_RETRIED");
  const batch = await sql.query(
    "SELECT snapshot FROM axfluxo_video.render_batches WHERE owner_id=$1 AND id=$2",
    [owner, row.batch_id],
  );
  const snapshot = executionSnapshot(batch.rows[0].snapshot);
  await capacityGuard(sql, owner);
  await checkResources(sql, owner, snapshot);
  const index = Number(row.rangeIndex),
    units = cost(snapshot, index, unitsPerFrame);
  await reserve(sql, owner, units);
  const job = await createJob(
    sql,
    owner,
    String(row.batch_id),
    snapshot,
    index,
    Number(row.attempt) + 1,
    id,
    units,
  );
  await sql.query(
    "INSERT INTO axfluxo_video.audit_events(id,owner_id,action,batch_id,job_id) VALUES ($1,$2,'job.retried',$3,$4)",
    [randomUUID(), owner, row.batch_id, job.id],
  );
  return { batchId: String(row.batch_id), job };
}
export async function cancelJob(sql: Sql, owner: string, id: string) {
  const { rows } = await sql.query(
    `SELECT ${jobColumns},batch_id FROM axfluxo_video.render_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
    [owner, id],
  );
  if (!rows.length) throw new ApiError(404, "NOT_FOUND");
  const row = rows[0];
  if (["failed", "succeeded", "interrupted"].includes(String(row.state)))
    throw new ApiError(409, "JOB_NOT_CANCELLABLE");
  if (!["cancel_requested", "cancelled"].includes(String(row.state))) {
    await sql.query(
      "UPDATE axfluxo_video.render_jobs SET state='cancel_requested',cancel_requested_at=now() WHERE owner_id=$1 AND id=$2",
      [owner, id],
    );
    await sql.query(
      "INSERT INTO axfluxo_video.outbox_events(id,owner_id,job_id,event_type) VALUES ($1,$2,$3,'cancel.requested')",
      [randomUUID(), owner, id],
    );
    await sql.query(
      "INSERT INTO axfluxo_video.audit_events(id,owner_id,action,batch_id,job_id) VALUES ($1,$2,'job.cancel_requested',$3,$4)",
      [randomUUID(), owner, row.batch_id, id],
    );
    row.state = "cancel_requested";
  }
  // Reservation/pins remain until a future worker acknowledges stopped execution.
  return {
    batchId: String(row.batch_id),
    job: jobViewSchema.parse({
      id: row.id,
      state: row.state,
      rangeIndex: row.rangeIndex,
      attempt: row.attempt,
      retryOf: row.retryOf,
    }),
  };
}

/** Optional V7 gate: no eviction of unconfirmed outputs to satisfy admission. */
export async function capacityGuard(sql: Sql, owner: string) {
  if (
    process.env.VIDEO_CAPACITY_GUARD_ENABLED !== "true" &&
    process.env.VIDEO_OUTPUTS_ENABLED !== "true"
  )
    return;
  const minimum = Number(process.env.VIDEO_CAPACITY_MIN_FREE_BYTES ?? 67108864);
  if (!Number.isSafeInteger(minimum) || minimum < 1)
    throw new ApiError(503, "CAPACITY_HELD");
  const row = (
    await sql.query(
      "SELECT owner_id FROM axfluxo_video.media_quotas WHERE owner_id=$1 AND NOT blocked AND limit_bytes IS NOT NULL AND limit_bytes-used_bytes-reserved_bytes >= $2::bigint FOR UPDATE",
      [owner, minimum],
    )
  ).rows[0];
  if (!row) throw new ApiError(503, "CAPACITY_HELD");
}
