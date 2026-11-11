import { randomUUID } from "node:crypto";
import { type Database, type Row, type Sql } from "../db/database";
import { digest } from "../api/jobs";
import { ApiError } from "../api/errors";
import { concatenateFrames, toFrame } from "../../src/domain/video/time";
import {
  exportJobViewSchema,
  exportOutputName,
  EXPORT_FONT_HASH,
  EXPORT_RENDERER,
  EXPORT_PROFILE,
  type ExportJobRequest,
  type ExportJobView,
} from "../../src/domain/cloud-export/schema";
import {
  blobView,
  exportScoped,
  requireExportMembership,
  type BlobRow,
} from "./storage";
import { ExportError, exportCodeOf, retryable } from "./errors";

export type StoredSpec = ExportJobRequest & {
  design: ExportJobRequest["design"] & {
    fontHash: string;
    rendererVersion: string;
    layout: "provisional-v1";
  };
};
export type JobRow = Row & {
  id: string;
  owner_id: string;
  state: ExportJobView["state"];
  spec: StoredSpec;
  spec_hash: string;
  progress_frame: string | number;
  total_frames: string | number;
  attempts: number;
  error_code: string | null;
  output_blob_id: string | null;
  output_validation: {
    width: number;
    height: number;
    frames: number;
    durationUs: number;
    sha256: string;
    size: number;
  } | null;
  created_at: Date | string;
  finished_at: Date | string | null;
};

/** Exact same frame arithmetic as the renderer, computed without importing worker code. */
export function specFrames(spec: ExportJobRequest) {
  const durations = spec.clips.map((c) => c.endUs - c.startUs);
  let boundaries;
  try {
    boundaries = concatenateFrames(durations);
  } catch {
    throw new ApiError(400, "EXPORT_INPUT_UNSUPPORTED");
  }
  let offset = 0;
  const intervals: { startFrame: number; endFrame: number }[] = [];
  spec.clips.forEach((clip, index) => {
    const bounds = [clip.startUs, ...clip.markersUs, clip.endUs];
    for (let i = 0; i + 1 < bounds.length; i++)
      intervals.push({
        startFrame: toFrame(offset + bounds[i] - clip.startUs),
        endFrame: toFrame(offset + bounds[i + 1] - clip.startUs),
      });
    offset += durations[index];
  });
  return { total: boundaries.at(-1)!.endFrame, intervals };
}

export function normalizeSpec(
  request: ExportJobRequest,
  limits: { maxFrames: number; maxClips: number },
): StoredSpec {
  if (request.clips.length > limits.maxClips)
    throw new ApiError(400, "EXPORT_LIMIT_EXCEEDED");
  const { total, intervals } = specFrames(request);
  if (total <= 0) throw new ApiError(400, "EXPORT_INPUT_UNSUPPORTED");
  if (total > limits.maxFrames)
    throw new ApiError(400, "EXPORT_LIMIT_EXCEEDED");
  if (intervals.length !== request.names.length)
    throw new ApiError(400, "EXPORT_INPUT_UNSUPPORTED");
  if (
    intervals.some(
      (i) =>
        i.endFrame - i.startFrame <
        request.design.fadeInFrames + request.design.fadeOutFrames,
    )
  )
    throw new ApiError(400, "EXPORT_INPUT_UNSUPPORTED");
  return {
    ...request,
    names: request.names.map((n) => n.trim()),
    design: {
      ...request.design,
      fontHash: EXPORT_FONT_HASH,
      rendererVersion: EXPORT_RENDERER,
      layout: "provisional-v1",
    },
  };
}

function view(row: JobRow): ExportJobView {
  return exportJobViewSchema.parse({
    id: row.id,
    state: row.state,
    errorCode:
      row.error_code && row.state === "failed" ? row.error_code : null,
    completedFrames: Number(row.progress_frame),
    totalFrames: Number(row.total_frames),
    output:
      row.state === "succeeded" && row.output_validation
        ? {
            filename: exportOutputName,
            fps: EXPORT_PROFILE.fps,
            ...row.output_validation,
            size: Number(row.output_validation.size),
          }
        : null,
    createdAt: new Date(row.created_at).toISOString(),
    finishedAt: row.finished_at
      ? new Date(row.finished_at).toISOString()
      : null,
  });
}

async function ownedBlob(
  sql: Sql,
  owner: string,
  id: string,
  kind: "video" | "image",
) {
  const row = (
    await sql.query<BlobRow>(
      "SELECT * FROM axfluxo_export.blobs WHERE owner_id=$1 AND id=$2 AND kind=$3 AND state='ready'",
      [owner, id, kind],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "EXPORT_INPUT_MISSING");
  return row;
}

export async function createJob(
  db: Database,
  owner: string,
  request: ExportJobRequest,
  key: string,
  requestHash: string,
  limits: { maxFrames: number; maxClips: number },
): Promise<ExportJobView> {
  const spec = normalizeSpec(request, limits);
  const specHash = digest(spec);
  return exportScoped(db, owner, async (sql) => {
    await requireExportMembership(sql, owner);
    for (const clip of spec.clips) await ownedBlob(sql, owner, clip.blobId, "video");
    await ownedBlob(sql, owner, spec.coverBlobId, "image");
    const { total } = specFrames(spec);
    const id = randomUUID();
    // ON CONFLICT keeps this transaction usable for the idempotent re-read below.
    const inserted = await sql.query(
      "INSERT INTO axfluxo_export.jobs(id,owner_id,idempotency_key,request_hash,spec,spec_hash,total_frames) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT (owner_id,idempotency_key) DO NOTHING RETURNING id",
      [id, owner, key, requestHash, JSON.stringify(spec), specHash, total],
    );
    if (!inserted.rows.length) {
      const existing = (
        await sql.query<JobRow>(
          "SELECT * FROM axfluxo_export.jobs WHERE owner_id=$1 AND idempotency_key=$2",
          [owner, key],
        )
      ).rows[0];
      if (!existing || existing.request_hash !== requestHash)
        throw new ApiError(409, "EXPORT_CONFLICT");
      return view(existing);
    }
    for (const clip of spec.clips)
      await sql.query(
        "INSERT INTO axfluxo_export.job_blobs(job_id,owner_id,blob_id,role) VALUES($1,$2,$3,'clip') ON CONFLICT DO NOTHING",
        [id, owner, clip.blobId],
      );
    await sql.query(
      "INSERT INTO axfluxo_export.job_blobs(job_id,owner_id,blob_id,role) VALUES($1,$2,$3,'cover') ON CONFLICT DO NOTHING",
      [id, owner, spec.coverBlobId],
    );
    const row = (
      await sql.query<JobRow>(
        "SELECT * FROM axfluxo_export.jobs WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    return view(row);
  });
}

export async function getJob(
  db: Database,
  owner: string,
  id: string,
): Promise<ExportJobView> {
  return exportScoped(db, owner, async (sql) => {
    await requireExportMembership(sql, owner);
    const row = (
      await sql.query<JobRow>(
        "SELECT * FROM axfluxo_export.jobs WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "EXPORT_NOT_FOUND");
    return view(row);
  });
}

export async function cancelJob(
  db: Database,
  owner: string,
  id: string,
): Promise<ExportJobView> {
  return exportScoped(db, owner, async (sql) => {
    await requireExportMembership(sql, owner);
    const row = (
      await sql.query<JobRow>(
        "SELECT * FROM axfluxo_export.jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "EXPORT_NOT_FOUND");
    if (row.state === "queued") {
      await sql.query(
        "UPDATE axfluxo_export.jobs SET state='cancelled',finished_at=now(),error_code='EXPORT_CANCELLED' WHERE owner_id=$1 AND id=$2",
        [owner, id],
      );
      row.state = "cancelled";
      row.error_code = "EXPORT_CANCELLED";
      row.finished_at = new Date();
    } else if (row.state === "running") {
      await sql.query(
        "UPDATE axfluxo_export.jobs SET state='cancel_requested' WHERE owner_id=$1 AND id=$2",
        [owner, id],
      );
      row.state = "cancel_requested";
    } else if (row.state !== "cancel_requested") {
      throw new ApiError(409, "EXPORT_CONFLICT");
    }
    return view(row);
  });
}

export async function findOutputBlob(
  db: Database,
  owner: string,
  sha256: string,
  size: number,
) {
  return exportScoped(db, owner, async (sql) => {
    const row = (
      await sql.query<BlobRow>(
        "SELECT * FROM axfluxo_export.blobs WHERE owner_id=$1 AND kind='output' AND sha256=$2 AND size=$3 AND state='ready'",
        [owner, sha256, size],
      )
    ).rows[0];
    return row ? blobView(row) : null;
  });
}

export type Claim = {
  owner: string;
  job: string;
  token: string;
  attempts: number;
  spec: StoredSpec;
};

async function terminate(
  sql: Sql,
  owner: string,
  job: string,
  state: "failed" | "cancelled" | "queued",
  code: string | null,
) {
  if (state === "queued")
    await sql.query(
      "UPDATE axfluxo_export.jobs SET state='queued',started_at=NULL WHERE owner_id=$1 AND id=$2",
      [owner, job],
    );
  else
    await sql.query(
      "UPDATE axfluxo_export.jobs SET state=$3,error_code=$4,finished_at=now() WHERE owner_id=$1 AND id=$2",
      [owner, job, state, code],
    );
}
async function unlock(sql: Sql) {
  await sql.query(
    "UPDATE axfluxo_export.slot SET owner_id=NULL,job_id=NULL,lease_until=NULL WHERE id=1",
  );
}

/**
 * Claims the single database-wide slot. A live lease excludes every other worker;
 * an expired lease is recovered only through the recorded attempts/lease history.
 */
export async function claim(db: Database): Promise<Claim | null> {
  return db.transaction(async (sql) => {
    const slot = (
      await sql.query<{
        token: string;
        owner_id: string | null;
        job_id: string | null;
        live: boolean;
      }>(
        "SELECT token,owner_id,job_id,lease_until>clock_timestamp() AS live FROM axfluxo_export.slot WHERE id=1 FOR UPDATE",
      )
    ).rows[0];
    if (slot.live) return null;
    if (slot.job_id && slot.owner_id) {
      const owner = slot.owner_id,
        job = slot.job_id;
      await sql.query("SELECT set_config('axfluxo.export_owner',$1,true)", [
        owner,
      ]);
      const current = (
        await sql.query<{ state: string; attempts: number }>(
          "SELECT state,attempts FROM axfluxo_export.jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
          [owner, job],
        )
      ).rows[0];
      if (current?.state === "cancel_requested")
        await terminate(sql, owner, job, "cancelled", "EXPORT_CANCELLED");
      else if (current?.state === "running")
        await terminate(
          sql,
          owner,
          job,
          current.attempts >= 3 ? "failed" : "queued",
          current.attempts >= 3 ? "EXPORT_WORKER_LOST" : null,
        );
      await unlock(sql);
    }
    const candidate = (
      await sql.query<{ id: string; owner_id: string }>(
        "SELECT id,owner_id FROM axfluxo_export.jobs WHERE state IN ('queued','cancel_requested') ORDER BY created_at,id LIMIT 1",
      )
    ).rows[0];
    if (!candidate) return null;
    const owner = candidate.owner_id,
      job = candidate.id;
    await sql.query("SELECT set_config('axfluxo.export_owner',$1,true)", [
      owner,
    ]);
    const locked = (
      await sql.query<JobRow>(
        "SELECT * FROM axfluxo_export.jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, job],
      )
    ).rows[0];
    if (!locked || !["queued", "cancel_requested"].includes(locked.state))
      return null;
    if (locked.state === "cancel_requested") {
      await terminate(sql, owner, job, "cancelled", "EXPORT_CANCELLED");
      return null;
    }
    if (locked.attempts >= 3) {
      await terminate(sql, owner, job, "failed", "EXPORT_WORKER_LOST");
      return null;
    }
    const member = await sql.query(
      "SELECT owner_id FROM axfluxo_video.developer_memberships WHERE owner_id=$1 AND active AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE",
      [owner],
    );
    if (!member.rows.length) {
      await terminate(sql, owner, job, "failed", "EXPORT_DISABLED");
      return null;
    }
    const token = String(
      (
        await sql.query<{ token: string }>(
          "UPDATE axfluxo_export.slot SET token=token+1,owner_id=$1,job_id=$2,lease_until=clock_timestamp()+interval '120 seconds' WHERE id=1 RETURNING token",
          [owner, job],
        )
      ).rows[0].token,
    );
    await sql.query(
      "UPDATE axfluxo_export.jobs SET state='running',attempts=attempts+1,started_at=coalesce(started_at,now()),progress_frame=0 WHERE owner_id=$1 AND id=$2",
      [owner, job],
    );
    return {
      owner,
      job,
      token,
      attempts: locked.attempts + 1,
      spec: locked.spec,
    };
  });
}

async function checkFence(sql: Sql, c: Claim) {
  const slot = (
    await sql.query<{
      token: string;
      owner_id: string | null;
      job_id: string | null;
      live: boolean;
    }>(
      "SELECT token,owner_id,job_id,lease_until>clock_timestamp() AS live FROM axfluxo_export.slot WHERE id=1 FOR UPDATE",
    )
  ).rows[0];
  if (
    !slot.live ||
    String(slot.token) !== c.token ||
    slot.owner_id !== c.owner ||
    slot.job_id !== c.job
  )
    throw new ExportError("EXPORT_LEASE_LOST");
  const job = (
    await sql.query<{ state: string }>(
      "SELECT state FROM axfluxo_export.jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
      [c.owner, c.job],
    )
  ).rows[0];
  if (job?.state === "cancel_requested")
    throw new ExportError("EXPORT_CANCELLED");
  if (job?.state !== "running") throw new ExportError("EXPORT_LEASE_LOST");
}

export async function fenced<T>(
  db: Database,
  c: Claim,
  work: (sql: Sql) => Promise<T>,
): Promise<T> {
  return exportScoped(db, c.owner, async (sql) => {
    await checkFence(sql, c);
    return work(sql);
  });
}

export async function heartbeat(db: Database, c: Claim) {
  return fenced(db, c, (sql) =>
    sql.query(
      "UPDATE axfluxo_export.slot SET lease_until=clock_timestamp()+interval '120 seconds' WHERE id=1",
    ),
  );
}

export async function progress(
  db: Database,
  c: Claim,
  frame: number,
) {
  await fenced(db, c, (sql) =>
    sql.query(
      "UPDATE axfluxo_export.jobs SET progress_frame=GREATEST(progress_frame,$3::bigint) WHERE owner_id=$1 AND id=$2",
      [c.owner, c.job, frame],
    ),
  );
}

/** A failed attempt either returns to the queue (bounded) or becomes terminal. */
export async function finishFailure(
  db: Database,
  c: Claim,
  error: unknown,
) {
  const code = exportCodeOf(error);
  return exportScoped(db, c.owner, async (sql) => {
    const slot = (
      await sql.query<{
        token: string;
        job_id: string | null;
        live: boolean;
      }>(
        "SELECT token,job_id,lease_until>clock_timestamp() AS live FROM axfluxo_export.slot WHERE id=1 FOR UPDATE",
      )
    ).rows[0];
    if (!slot.live || String(slot.token) !== c.token || slot.job_id !== c.job)
      return false;
    const job = (
      await sql.query<{ state: string; attempts: number }>(
        "SELECT state,attempts FROM axfluxo_export.jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [c.owner, c.job],
      )
    ).rows[0];
    if (job?.state === "cancel_requested")
      await terminate(sql, c.owner, c.job, "cancelled", "EXPORT_CANCELLED");
    else if (
      retryable.includes(code) &&
      job &&
      job.attempts < 3 &&
      job.state === "running"
    )
      await terminate(sql, c.owner, c.job, "queued", null);
    else
      await terminate(sql, c.owner, c.job, "failed", code);
    await unlock(sql);
    return true;
  });
}

export async function publish(
  db: Database,
  c: Claim,
  input: {
    blobId: string;
    size: number;
    sha256: string;
    validation: {
      width: number;
      height: number;
      frames: number;
      durationUs: number;
    };
  },
) {
  return fenced(db, c, async (sql) => {
    const blob = (
      await sql.query<BlobRow>(
        "SELECT * FROM axfluxo_export.blobs WHERE owner_id=$1 AND id=$2 AND kind='output' AND state='ready'",
        [c.owner, input.blobId],
      )
    ).rows[0];
    if (!blob || Number(blob.size) !== input.size || blob.sha256 !== input.sha256)
      throw new ExportError("EXPORT_OUTPUT_INVALID");
    await sql.query(
      "UPDATE axfluxo_export.jobs SET state='succeeded',output_blob_id=$3,output_validation=$4::jsonb,progress_frame=$5,error_code=NULL,finished_at=now() WHERE owner_id=$1 AND id=$2",
      [
        c.owner,
        c.job,
        input.blobId,
        JSON.stringify({ ...input.validation, size: input.size, sha256: input.sha256 }),
        input.validation.frames,
      ],
    );
    await unlock(sql);
  });
}

/** Resolves the published, ready output blob for a succeeded job. */
export async function outputBlob(db: Database, owner: string, id: string) {
  return exportScoped(db, owner, async (sql) => {
    const job = (
      await sql.query<{ state: string; output_blob_id: string | null }>(
        "SELECT state,output_blob_id FROM axfluxo_export.jobs WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    if (!job) throw new ApiError(404, "EXPORT_NOT_FOUND");
    if (job.state !== "succeeded" || !job.output_blob_id)
      throw new ApiError(409, "EXPORT_BUSY");
    const row = (
      await sql.query<BlobRow>(
        "SELECT * FROM axfluxo_export.blobs WHERE owner_id=$1 AND id=$2 AND kind='output' AND state='ready'",
        [owner, job.output_blob_id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "EXPORT_NOT_FOUND");
    return row;
  });
}
