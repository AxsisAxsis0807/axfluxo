import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Sql } from "../db/database";
import type { Database } from "../db/database";
import type { MultipartStorage } from "../storage/multipart";
import {
  allVersionsDocumentSchema,
  fnfSnapshotSchema,
} from "../../src/domain/video/schema";
import { createBatch, digest, idempotent, requireMembership } from "./jobs";
import { jsonBody } from "./app";
import { ApiError } from "./errors";
import { renderCodes } from "../worker/jobs/errors";
export function renderRouter(config: {
  accessGuard?: (sql: Sql, owner: string, id: string) => Promise<void>;
  db: Database;
  storage: MultipartStorage | null;
  enabled: () => boolean;
  unitsPerFrame?: number;
}) {
  return async (request: Request, owner: string) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/render-all-versions") {
      const key = request.headers.get("idempotency-key");
      if (!key || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key))
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
      const body = z
        .strictObject({ document: allVersionsDocumentSchema })
        .parse(await jsonBody(request));
      if (body.document.clips.length > 100)
        throw new ApiError(400, "VALIDATION_FAILED");
      return config.db.transaction(async (sql) => {
        await requireMembership(sql, owner);
        return idempotent(sql, owner, key, digest({ path, body }), async () => {
          if (!config.enabled()) throw new ApiError(503, "ADMISSION_CLOSED");
          const duration = body.document.clips.reduce(
            (n, c) => n + c.interval.endUs - c.interval.startUs,
            0,
          );
          const snapshot = fnfSnapshotSchema.parse({
            schemaVersion: 1,
            id: randomUUID(),
            document: body.document,
            ranges: [{ startUs: 0, endUs: duration }],
            names: ["all-versions.mp4"],
          });
          const batch = await createBatch(
            sql,
            owner,
            snapshot,
            config.unitsPerFrame,
          );
          await sql.query(
            "INSERT INTO axfluxo_video.render_batch_options(owner_id,batch_id,mode) VALUES($1,$2,'all-versions')",
            [owner, batch.id],
          );
          return { status: 202, body: batch };
        });
      });
    }
    const progress = /^\/render-jobs\/([a-f0-9-]+)\/progress$/.exec(path),
      access = /^\/render-outputs\/([a-f0-9-]+)\/access$/.exec(path);
    if (request.method !== "GET" || (!progress && !access))
      throw new ApiError(404, "NOT_FOUND");
    const id = z.uuid().parse((progress ?? access)![1]);
    const result = await config.db.transaction(async (sql) => {
      await requireMembership(sql, owner);
      if (progress) {
        const row = (
          await sql.query(
            "SELECT j.state,e.runs,e.progress_frame,e.total_frames,e.error_code,e.next_at FROM axfluxo_video.render_jobs j LEFT JOIN axfluxo_video.render_executions e ON e.owner_id=j.owner_id AND e.job_id=j.id WHERE j.owner_id=$1 AND j.id=$2",
            [owner, id],
          )
        ).rows[0];
        if (!row) throw new ApiError(404, "NOT_FOUND");
        return {
          status: 200,
          body: {
            jobId: id,
            state: row.state,
            runs: Number(row.runs ?? 0),
            completedFrames: Number(row.progress_frame ?? 0),
            totalFrames: Number(row.total_frames ?? 0),
            errorCode: renderCodes.includes(
              row.error_code as (typeof renderCodes)[number],
            )
              ? row.error_code
              : null,
            retryAt:
              row.state === "queued" && row.next_at
                ? new Date(String(row.next_at)).toISOString()
                : null,
          },
        };
      }
      await config.accessGuard?.(sql, owner, id);
      const row = (
        await sql.query(
          "SELECT to_jsonb(o)->>'storage_namespace' AS storage_namespace,o.object_key,o.hash,o.size,CASE WHEN b.snapshot->>'kind'='fnf-showcase-snapshot' THEN b.snapshot->'names'->>j.range_index ELSE 'output.mp4' END AS filename FROM axfluxo_video.render_artifacts a JOIN axfluxo_video.render_objects o ON o.owner_id=a.owner_id AND o.id=a.object_id JOIN axfluxo_video.render_outputs r ON r.owner_id=a.owner_id AND r.id=a.output_id JOIN axfluxo_video.render_jobs j ON j.owner_id=r.owner_id AND j.id=r.job_id JOIN axfluxo_video.render_batches b ON b.owner_id=j.owner_id AND b.id=j.batch_id WHERE a.owner_id=$1 AND a.output_id=$2 AND o.ready AND j.state='succeeded'",
          [owner, id],
        )
      ).rows[0];
      if (!row) throw new ApiError(404, "NOT_FOUND");
      return { status: 200, body: row };
    });
    if (progress) return result;
    if (!config.storage) throw new ApiError(503, "STORAGE_UNAVAILABLE");
    let signed;
    try {
      signed = await (
        config.storage.forRenderObject?.(
          String(result.body.storage_namespace ?? "legacy"),
        ) ?? config.storage
      ).access(
        String(result.body.object_key),
        "video/mp4",
        String(result.body.filename ?? "output.mp4"),
      );
    } catch {
      throw new ApiError(503, "STORAGE_UNAVAILABLE");
    }
    const url = new URL(signed.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      signed.expiresAt <= Date.now()
    )
      throw new ApiError(503, "STORAGE_UNAVAILABLE");
    await config.db.transaction((sql) => requireMembership(sql, owner));
    return {
      status: 200,
      body: {
        ...signed,
        hash: result.body.hash,
        size: Number(result.body.size),
      },
    };
  };
}
