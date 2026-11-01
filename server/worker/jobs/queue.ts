import type { Database, Sql, Row } from "../../db/database";
import {
  fnfSnapshotSchema,
  type FnfSnapshot,
} from "../../../src/domain/video/schema";
import { digest } from "../../api/jobs";
import { RenderError, heldCode, retryDelay, type RenderCode } from "./errors";
import type { RenderMode } from "../render/plan";
export type Claim = {
  owner: string;
  job: string;
  batch: string;
  token: string;
  runs: number;
  snapshot: FnfSnapshot;
  rangeIndex: number;
  mode: RenderMode;
};
const scope = (sql: Sql, owner: string) =>
  sql.query("SELECT set_config('axfluxo.owner_id',$1,true)", [owner]);
async function settle(sql: Sql, owner: string, job: string) {
  const r = await sql.query(
    "UPDATE axfluxo_video.usage_reservations SET state='consumed' WHERE owner_id=$1 AND job_id=$2 AND state='reserved' RETURNING units",
    [owner, job],
  );
  if (r.rows.length)
    await sql.query(
      "UPDATE axfluxo_video.usage_budgets SET reserved_units=reserved_units-$2::bigint,consumed_units=consumed_units+$2::bigint WHERE owner_id=$1",
      [owner, String(r.rows[0].units)],
    );
}
async function unlock(sql: Sql) {
  await sql.query(
    "UPDATE axfluxo_video.render_slot SET owner_id=NULL,job_id=NULL,lease_until=NULL WHERE id=1",
  );
}
async function terminate(
  sql: Sql,
  owner: string,
  job: string,
  state: string,
  code: RenderCode | null,
) {
  await sql.query(
    "UPDATE axfluxo_video.render_jobs SET state=$3 WHERE owner_id=$1 AND id=$2",
    [owner, job, state],
  );
  await sql.query(
    "UPDATE axfluxo_video.render_executions SET error_code=$3 WHERE owner_id=$1 AND job_id=$2",
    [owner, job, code],
  );
  if (["failed", "cancelled", "succeeded"].includes(state))
    await settle(sql, owner, job);
  await sql.query(
    "UPDATE axfluxo_video.outbox_events SET state='delivered',locked_until=NULL WHERE owner_id=$1 AND job_id=$2",
    [owner, job],
  );
}
async function failure(
  sql: Sql,
  owner: string,
  job: string,
  runs: number,
  code: RenderCode,
  random: () => number,
) {
  const delay = retryDelay(code, runs, random);
  if (delay !== null) {
    await sql.query(
      "UPDATE axfluxo_video.render_jobs SET state='queued' WHERE owner_id=$1 AND id=$2",
      [owner, job],
    );
    await sql.query(
      "UPDATE axfluxo_video.render_executions SET next_at=clock_timestamp()+$3::integer*interval '1 second',error_code=$4 WHERE owner_id=$1 AND job_id=$2",
      [owner, job, delay, code],
    );
  } else
    await terminate(sql, owner, job, heldCode(code) ? "held" : "failed", code);
}
/** Lock singleton first everywhere: one active lease cluster-wide; owner-scoped job lock. */
export async function claim(
  db: Database,
  random = Math.random,
): Promise<Claim | null> {
  return db.transaction(async (sql) => {
    const slot = (
      await sql.query(
        "SELECT *,lease_until>clock_timestamp() AS live FROM axfluxo_video.render_slot WHERE id=1 FOR UPDATE",
      )
    ).rows[0];
    if (slot.live) return null;
    if (slot.job_id) {
      const owner = String(slot.owner_id),
        job = String(slot.job_id);
      await scope(sql, owner);
      const j = (
        await sql.query(
          "SELECT state FROM axfluxo_video.render_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
          [owner, job],
        )
      ).rows[0];
      const e = (
        await sql.query(
          "SELECT runs FROM axfluxo_video.render_executions WHERE owner_id=$1 AND job_id=$2",
          [owner, job],
        )
      ).rows[0];
      if (j.state === "cancel_requested")
        await terminate(sql, owner, job, "cancelled", "CANCELLED");
      else if (j.state === "running")
        await failure(sql, owner, job, Number(e.runs), "WORKER_LOST", random);
      await unlock(sql);
    }
    const found = await sql.query(
      "SELECT j.* FROM axfluxo_video.render_jobs j LEFT JOIN axfluxo_video.render_executions e ON e.job_id=j.id WHERE j.state IN ('queued','cancel_requested') AND (e.next_at IS NULL OR e.next_at<=clock_timestamp()) ORDER BY j.created_at,j.id LIMIT 1",
    );
    if (!found.rows.length) return null;
    const row = found.rows[0],
      owner = String(row.owner_id),
      job = String(row.id);
    await scope(sql, owner);
    const locked = (
      await sql.query(
        "SELECT state FROM axfluxo_video.render_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, job],
      )
    ).rows[0];
    if (
      !locked ||
      !["queued", "cancel_requested"].includes(String(locked.state))
    )
      return null;
    row.state = locked.state;
    await sql.query(
      "INSERT INTO axfluxo_video.render_executions(owner_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [owner, job],
    );
    if (row.state === "cancel_requested") {
      await terminate(sql, owner, job, "cancelled", "CANCELLED");
      return null;
    }
    const member = await sql.query(
      "SELECT owner_id FROM axfluxo_video.developer_memberships WHERE owner_id=$1 AND active AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE",
      [owner],
    );
    if (!member.rows.length) {
      await terminate(sql, owner, job, "held", "DEVELOPER_REVOKED");
      return null;
    }
    const e = (
      await sql.query(
        "SELECT runs FROM axfluxo_video.render_executions WHERE owner_id=$1 AND job_id=$2",
        [owner, job],
      )
    ).rows[0];
    if (Number(e.runs) >= 3) {
      await terminate(sql, owner, job, "failed", "WORKER_LOST");
      return null;
    }
    const batch = (
      await sql.query(
        "SELECT snapshot,snapshot_hash FROM axfluxo_video.render_batches WHERE owner_id=$1 AND id=$2",
        [owner, row.batch_id],
      )
    ).rows[0];
    const parsed = fnfSnapshotSchema.safeParse(batch.snapshot);
    if (!parsed.success || digest(parsed.data) !== batch.snapshot_hash) {
      await terminate(sql, owner, job, "failed", "INPUT_CORRUPT");
      return null;
    }
    const mode =
      (
        await sql.query(
          "SELECT mode FROM axfluxo_video.render_batch_options WHERE owner_id=$1 AND batch_id=$2",
          [owner, row.batch_id],
        )
      ).rows[0]?.mode === "all-versions"
        ? "all-versions"
        : "fnf";
    const token = String(
      (
        await sql.query(
          "UPDATE axfluxo_video.render_slot SET token=token+1,owner_id=$1,job_id=$2,lease_until=clock_timestamp()+interval '90 seconds' WHERE id=1 RETURNING token",
          [owner, job],
        )
      ).rows[0].token,
    );
    await sql.query(
      "UPDATE axfluxo_video.render_executions SET token=$3::bigint,runs=runs+1,error_code=NULL WHERE owner_id=$1 AND job_id=$2",
      [owner, job, token],
    );
    await sql.query(
      "UPDATE axfluxo_video.render_jobs SET state='running' WHERE owner_id=$1 AND id=$2",
      [owner, job],
    );
    await sql.query(
      "UPDATE axfluxo_video.outbox_events SET state='delivered',delivery_attempts=delivery_attempts+1 WHERE owner_id=$1 AND job_id=$2 AND event_type='render.requested'",
      [owner, job],
    );
    return {
      owner,
      job,
      batch: String(row.batch_id),
      token,
      runs: Number(e.runs) + 1,
      snapshot: parsed.data,
      rangeIndex: Number(row.range_index),
      mode,
    };
  });
}
export async function fenced<T>(
  db: Database,
  c: Claim,
  work: (sql: Sql) => Promise<T>,
): Promise<T> {
  return db.transaction(async (sql) => {
    await scope(sql, c.owner);
    const s = (
      await sql.query(
        "SELECT *,lease_until>clock_timestamp() AS live FROM axfluxo_video.render_slot WHERE id=1 FOR UPDATE",
      )
    ).rows[0];
    if (
      !s.live ||
      String(s.token) !== c.token ||
      s.job_id !== c.job ||
      s.owner_id !== c.owner
    )
      throw new RenderError("LEASE_LOST");
    const j = (
      await sql.query(
        "SELECT state FROM axfluxo_video.render_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [c.owner, c.job],
      )
    ).rows[0];
    if (j.state === "cancel_requested") throw new RenderError("CANCELLED");
    if (j.state !== "running") throw new RenderError("LEASE_LOST");
    const m = await sql.query(
      "SELECT owner_id FROM axfluxo_video.developer_memberships WHERE owner_id=$1 AND active AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE",
      [c.owner],
    );
    if (!m.rows.length) throw new RenderError("DEVELOPER_REVOKED");
    await sql.query("SELECT set_config('axfluxo.render_token',$1,true)", [
      c.token,
    ]);
    return work(sql);
  });
}
export async function heartbeat(db: Database, c: Claim) {
  return fenced(db, c, (sql) =>
    sql.query(
      "UPDATE axfluxo_video.render_slot SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=1",
    ),
  );
}
export async function progress(
  db: Database,
  c: Claim,
  frame: number,
  total: number,
) {
  await fenced(db, c, (sql) =>
    sql.query(
      "UPDATE axfluxo_video.render_executions SET progress_frame=GREATEST(progress_frame,$3::bigint),total_frames=$4 WHERE owner_id=$1 AND job_id=$2",
      [c.owner, c.job, frame, total],
    ),
  );
}
export async function finishFailure(
  db: Database,
  c: Claim,
  code: RenderCode,
  random = Math.random,
) {
  return db.transaction(async (sql) => {
    await scope(sql, c.owner);
    const slot = (
      await sql.query(
        "SELECT *,lease_until>clock_timestamp() AS live FROM axfluxo_video.render_slot WHERE id=1 FOR UPDATE",
      )
    ).rows[0];
    if (!slot.live || String(slot.token) !== c.token || slot.job_id !== c.job)
      return false;
    const j = (
      await sql.query(
        "SELECT state FROM axfluxo_video.render_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [c.owner, c.job],
      )
    ).rows[0];
    if (j.state === "cancel_requested")
      await terminate(sql, c.owner, c.job, "cancelled", "CANCELLED");
    else await failure(sql, c.owner, c.job, c.runs, code, random);
    await unlock(sql);
    return true;
  });
}
export async function publish(
  db: Database,
  c: Claim,
  object: Row,
  validation: unknown,
  frames: number,
) {
  return fenced(db, c, async (sql) => {
    const o = (
      await sql.query(
        "SELECT id,hash FROM axfluxo_video.render_objects WHERE owner_id=$1 AND job_id=$2 AND id=$3 AND kind='output' AND ready",
        [c.owner, c.job, object.id],
      )
    ).rows[0];
    if (!o) throw new RenderError("VALIDATION_FAILED");
    const { randomUUID } = await import("node:crypto");
    const id = randomUUID(),
      file = randomUUID(),
      version = randomUUID();
    await sql.query(
      "INSERT INTO axfluxo_video.resource_versions(owner_id,library_id,file_id,version_id,hash,kind) VALUES($1,'render-output',$2,$3,$4,'video')",
      [c.owner, file, version, o.hash],
    );
    await sql.query(
      "INSERT INTO axfluxo_video.render_outputs(id,owner_id,job_id,library_id,file_id,version_id,hash,frame_count,fps) VALUES($1,$2,$3,'render-output',$4,$5,$6,$7,60)",
      [id, c.owner, c.job, file, version, o.hash, frames],
    );
    await sql.query(
      "INSERT INTO axfluxo_video.render_artifacts(owner_id,output_id,object_id,validation) VALUES($1,$2,$3,$4::jsonb)",
      [c.owner, id, o.id, JSON.stringify(validation)],
    );
    await sql.query(
      "UPDATE axfluxo_video.render_executions SET progress_frame=$3,total_frames=$3 WHERE owner_id=$1 AND job_id=$2",
      [c.owner, c.job, frames],
    );
    await terminate(sql, c.owner, c.job, "succeeded", null);
    await unlock(sql);
    return id;
  });
}
