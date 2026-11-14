import { previewAccess } from "../api/assets/preview";
import { drivePreviewStorage } from "./preview";
import type { Inventory } from "./service";
import { z } from "zod";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { jsonBody } from "../api/app";
import { ApiError } from "../api/errors";
import {
  digest,
  idempotent,
  createBatch,
  getBatch,
  cancelJob,
  resumeJob,
  retryJob,
  requireMembership,
} from "../api/jobs";
import { executionSnapshot } from "../contracts/snapshot";
import {
  allVersionsProjectSchema,
  projectIssues,
} from "../../src/domain/video/all-versions";
import type { Sql } from "../db/database";
import { sha256, secret } from "../google-drive/security";
import type { DriveCloud } from "./service";
import { DRIVE_CHUNK } from "./transfer";
const prefix = "/v1/drive";
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const start = z.strictObject({
  size: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mime: z.enum([
    "video/mp4",
    "video/quicktime",
    "audio/mpeg",
    "audio/wav",
    "image/png",
    "image/jpeg",
    "image/webp",
  ]),
  name: z.string().min(1).max(200),
});
const key = (r: Request) => {
  const k = r.headers.get("idempotency-key");
  if (!k || !/^[\w.:-]{8,128}$/.test(k))
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
  return k;
};
export function byteRange(
  value: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!value) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) throw new ApiError(416, "RANGE_NOT_SATISFIABLE");
  const a = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])),
    b = m[1] ? (m[2] ? Math.min(size - 1, Number(m[2])) : size - 1) : size - 1;
  if (
    !Number.isSafeInteger(a) ||
    !Number.isSafeInteger(b) ||
    a < 0 ||
    a >= size ||
    b < a
  )
    throw new ApiError(416, "RANGE_NOT_SATISFIABLE");
  return { start: a, end: b };
}
export function driveCloudRouter(
  service: DriveCloud,
  unitsPerFrame?: number,
  previewUnitsPerSecond?: number,
) {
  const enabled = () => {
    if (!service.policy.enabled()) throw new ApiError(503, "DRIVE_CLOUD_HELD");
  };
  async function reserveJobs(
    sql: Sql,
    owner: string,
    jobs: { id: string }[],
    each: number,
  ) {
    const room = await sql.query(
      "UPDATE axfluxo_video.drive_capacity SET reserved_bytes=reserved_bytes+$2::bigint WHERE owner_id=$1 AND observed_at>now()-interval '5 minutes' AND used_bytes+reserved_bytes+$2::bigint+$3::bigint<=LEAST(limit_bytes,$4::bigint) AND reserved_bytes+$2::bigint+$3::bigint<=observed_free RETURNING owner_id",
      [
        owner,
        each * jobs.length,
        service.policy.marginBytes,
        service.policy.limitBytes,
      ],
    );
    if (!room.rows.length) throw new ApiError(503, "DRIVE_CAPACITY_HELD");
    for (const job of jobs)
      await sql.query(
        "INSERT INTO axfluxo_video.drive_job_capacity(owner_id,job_id,remaining) VALUES($1,$2,$3)",
        [owner, job.id, each],
      );
  }
  async function handler(
    request: Request,
    owner: string,
  ): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    const media = /^\/cloud\/versions\/([a-f0-9-]+)\/(access|preview)$/.exec(
      path,
    );
    if (media) {
      const installed = await service.owner(
        owner,
        async (sql) =>
          (
            await sql.query(
              "SELECT to_regclass('axfluxo_video.drive_inventory') IS NOT NULL AS installed",
            )
          ).rows[0]?.installed,
      );
      if (!installed) return null;
      const row = await service.owner(
        owner,
        async (sql) =>
          (
            await sql.query<Inventory>(
              "SELECT * FROM axfluxo_video.drive_inventory WHERE owner_id=$1 AND version_id::text=$2 AND namespace='original' AND state='ready'",
              [owner, z.uuid().parse(media[1])],
            )
          ).rows[0],
      );
      if (!row) return null;
      const storage = drivePreviewStorage(service, owner, media[1]);
      if (media[2] === "access" && request.method === "GET")
        return json(await storage.access(row.object_key));
      if (media[2] === "preview" && request.method === "POST") {
        if (service.policy.enabled())
          await service.owner(owner, (sql) =>
            sql.query(
              "UPDATE axfluxo_video.media_preview_jobs SET state='queued',error_code=NULL WHERE owner_id=$1 AND version_id=$2 AND state='failed' AND drive_runs<3",
              [owner, media[1]],
            ),
          );
        return json(
          await previewAccess(
            {
              db: service.db,
              storage,
              enabled: service.policy.enabled,
              unitsPerSecond: previewUnitsPerSecond,
            },
            owner,
            media[1],
          ),
        );
      }
      throw new ApiError(405, "METHOD_NOT_ALLOWED");
    }
    if (!path.startsWith(prefix + "/")) return null;
    await service.owner(owner, async () => undefined);
    if (path === prefix + "/status" && request.method === "GET") {
      const row = await service.owner(
        owner,
        async (sql) =>
          (
            await sql.query(
              "SELECT connected FROM axfluxo_video.drive_connections WHERE owner_id=$1",
              [owner],
            )
          ).rows[0],
      );
      return json({
        enabled: service.policy.enabled(),
        connected: row?.connected ?? false,
        chunkBytes: DRIVE_CHUNK,
        maxFileBytes: service.policy.maxFileBytes,
        monthlyEstimateYen: service.policy.monthlyYen,
        priceConfirmed: service.policy.enabled(),
        allow1440: service.policy.allow1440,
      });
    }
    if (path === prefix + "/usage" && request.method === "GET")
      return json(
        await service.owner(owner, async (sql) => ({
          capacity:
            (
              await sql.query(
                "SELECT limit_bytes,used_bytes,reserved_bytes,observed_free,observed_at FROM axfluxo_video.drive_capacity WHERE owner_id=$1",
                [owner],
              )
            ).rows[0] ?? null,
          monthly: (
            await sql.query(
              "SELECT kind,sum(bytes)::text AS bytes,count(*)::integer AS operations FROM axfluxo_video.drive_usage WHERE owner_id=$1 AND created_at>=date_trunc('month',now() AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo' GROUP BY kind",
              [owner],
            )
          ).rows,
          unconfirmed: Number(
            (
              await sql.query(
                "SELECT count(*)::integer AS count FROM axfluxo_video.render_outputs o JOIN axfluxo_video.render_artifacts a ON a.owner_id=o.owner_id AND a.output_id=o.id JOIN axfluxo_video.render_objects r ON r.owner_id=a.owner_id AND r.id=a.object_id LEFT JOIN axfluxo_video.drive_saved s ON s.owner_id=o.owner_id AND s.output_id=o.id WHERE o.owner_id=$1 AND r.storage_namespace='drive-v1' AND s.output_id IS NULL",
                [owner],
              )
            ).rows[0].count,
          ),
        })),
      );
    const upload =
      /^\/v1\/drive\/uploads\/([a-f0-9-]+)(?:\/chunks\/(\d+)\/([a-f0-9]{64})|\/(resume))?$/.exec(
        path,
      );
    if (path === prefix + "/uploads" && request.method === "POST") {
      enabled();
      const body = start.parse(await jsonBody(request));
      if (body.size > service.policy.maxFileBytes)
        throw new ApiError(413, "BODY_TOO_LARGE");
      const row = await service.reserve(owner, {
        key: key(request),
        size: body.size,
        hash: body.sha256,
        mime: body.mime,
        name: body.name,
      });
      return json(service.view(row), 201);
    }
    if (upload) {
      const id = z.uuid().parse(upload[1]);
      if (request.method === "GET")
        return json(await service.status(owner, id));
      if (request.method === "POST" && upload[4] === "resume") {
        enabled();
        await service.owner(owner, async (sql) => {
          const row = await sql.query(
            "UPDATE axfluxo_video.drive_inventory SET state=CASE WHEN offset_bytes=size THEN 'verifying' ELSE 'uploading' END,error_code=NULL WHERE owner_id=$1 AND id=$2 AND namespace='original' AND state='held' AND verify_runs<3 AND (lease_until IS NULL OR lease_until<now()) RETURNING id",
            [owner, id],
          );
          if (!row.rows.length) throw new ApiError(409, "DRIVE_NOT_RESUMABLE");
        });
        return json(await service.status(owner, id, false));
      }
      if (request.method === "POST" && upload[2]) {
        enabled();
        if (
          request.headers.get("content-type") !== "application/octet-stream" ||
          request.headers.has("content-encoding")
        )
          throw new ApiError(415, "BINARY_REQUIRED");
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = request.body?.getReader();
        if (!reader) throw new ApiError(400, "BODY_REQUIRED");
        try {
          while (true) {
            const r = await reader.read();
            if (r.done) break;
            size += r.value.length;
            if (size > DRIVE_CHUNK) {
              await reader.cancel();
              throw new ApiError(413, "BODY_TOO_LARGE");
            }
            chunks.push(r.value);
          }
        } finally {
          reader.releaseLock();
        }
        return json(
          await service.chunk(
            owner,
            id,
            Number(upload[2]),
            Buffer.concat(chunks),
            upload[3],
            request.signal,
          ),
        );
      }
    }
    if (path === prefix + "/batches" && request.method === "GET")
      return json(
        await service.owner(owner, async (sql) => ({
          items: (
            await sql.query(
              "SELECT b.batch_id AS id,r.created_at FROM axfluxo_video.drive_batches b JOIN axfluxo_video.render_batches r ON r.owner_id=b.owner_id AND r.id=b.batch_id WHERE b.owner_id=$1 ORDER BY r.created_at DESC LIMIT 20",
              [owner],
            )
          ).rows,
        })),
      );
    if (path === prefix + "/batches" && request.method === "POST") {
      enabled();
      const k = key(request),
        body = z
          .strictObject({
            snapshot: z.unknown(),
            project: allVersionsProjectSchema.optional(),
          })
          .parse(await jsonBody(request));
      const snapshot = executionSnapshot(body.snapshot),
        project = body.project;
      if (snapshot.document.clips.length > 100 || snapshot.ranges.length > 100)
        throw new ApiError(400, "VALIDATION_FAILED");
      if (
        project &&
        (projectIssues(project).length ||
          JSON.stringify(project.document) !==
            JSON.stringify(snapshot.document))
      )
        throw new ApiError(422, "PROJECT_INVALID");
      if (project?.design.height === 1440 && !service.policy.allow1440)
        throw new ApiError(503, "DRIVE_PROFILE_HELD");
      if (!project && !(body.snapshot as { kind?: string })?.kind)
        throw new ApiError(422, "DRIVE_SNAPSHOT_INVALID");
      // Refresh physical capacity before the short admission transaction, never while holding queue locks.
      await service.databaseRoom();
      const observed = await service.transfer(owner).capacity();
      return service
        .owner(owner, async (sql) =>
          idempotent(sql, owner, k, digest({ path, body }), async () => {
            await sql.query("SELECT axfluxo_video.lock_render_slot()");
            const refs = [
              ...snapshot.document.clips.map((c) => c.source),
              ...(project?.cover ? [project.cover] : []),
            ];
            let sourceBytes = 0;
            for (const r of refs) {
              const row = (
                await sql.query(
                  "SELECT size FROM axfluxo_video.drive_inventory WHERE owner_id=$1 AND version_id::text=$2 AND asset_id::text=$3 AND hash=$4 AND state='ready' AND namespace='original'",
                  [owner, r.versionId, r.fileId, r.hash],
                )
              ).rows[0];
              if (!row) throw new ApiError(409, "DRIVE_WORKER_NOT_READY");
              sourceBytes += Number(row.size);
            }
            const seconds = snapshot.ranges.reduce(
                (n, r) => n + (r.endUs - r.startUs) / 1e6,
                0,
              ),
              peak = Math.ceil(seconds * 2_000_000 * 4);
            if (
              sourceBytes + peak + service.policy.marginBytes >
              service.policy.maxWorkBytes
            )
              throw new ApiError(503, "DRIVE_DISK_HELD");
            const c = (
              await sql.query(
                "SELECT account_id FROM axfluxo_video.drive_connections WHERE owner_id=$1",
                [owner],
              )
            ).rows[0];
            if (c?.account_id !== observed.account)
              throw new ApiError(409, "DRIVE_CONNECTION_CHANGED");
            await sql.query(
              "UPDATE axfluxo_video.drive_capacity SET observed_free=$2,observed_at=now() WHERE owner_id=$1",
              [owner, observed.free],
            );
            await sql.query(
              "INSERT INTO axfluxo_video.media_quotas(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
              [owner],
            );
            const batch = await createBatch(
              sql,
              owner,
              snapshot,
              unitsPerFrame,
              async () => undefined,
            );
            await reserveJobs(
              sql,
              owner,
              batch.jobs,
              Math.ceil(peak / batch.jobs.length),
            );
            await sql.query(
              "INSERT INTO axfluxo_video.drive_batches(owner_id,batch_id,peak_bytes) VALUES($1,$2,$3)",
              [owner, batch.id, peak],
            );
            if (project) {
              await sql.query(
                "INSERT INTO axfluxo_video.render_batch_options(owner_id,batch_id,mode,project) VALUES($1,$2,'all-versions',$3::jsonb)",
                [owner, batch.id, JSON.stringify(project)],
              );
              const r = project.cover!;
              for (const job of batch.jobs)
                await sql.query(
                  "INSERT INTO axfluxo_video.resource_pins(id,owner_id,job_id,library_id,file_id,version_id,hash,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
                  [
                    randomUUID(),
                    owner,
                    job.id,
                    r.libraryId,
                    r.fileId,
                    r.versionId,
                    r.hash,
                    r.kind,
                  ],
                );
            }
            return { status: 202, body: { ...batch, workerReady: true } };
          }),
        )
        .then((r) => json(r.body, r.status));
    }
    const batch = /^\/v1\/drive\/batches\/([a-f0-9-]+)$/.exec(path),
      job = /^\/v1\/drive\/jobs\/([a-f0-9-]+)\/(resume|retry|cancel)$/.exec(
        path,
      );
    if (batch && request.method === "GET")
      return json(
        await service.owner(owner, (sql) =>
          getBatch(sql, owner, z.uuid().parse(batch[1])),
        ),
      );
    if (job && request.method === "POST") {
      if (job[2] !== "cancel") enabled();
      const id = z.uuid().parse(job[1]),
        k = key(request);
      return service
        .owner(owner, async (sql) => {
          await sql.query("SELECT axfluxo_video.lock_render_slot()");
          const row = (
            await sql.query(
              "SELECT j.batch_id,j.attempt,b.peak_bytes FROM axfluxo_video.render_jobs j JOIN axfluxo_video.drive_batches b ON b.owner_id=j.owner_id AND b.batch_id=j.batch_id WHERE j.owner_id=$1 AND j.id=$2 FOR UPDATE OF j",
              [owner, id],
            )
          ).rows[0];
          if (!row) throw new ApiError(404, "NOT_FOUND");
          return idempotent(sql, owner, k, digest({ path }), async () => {
            if (job[2] === "resume")
              return { status: 200, body: await resumeJob(sql, owner, id) };
            if (job[2] === "cancel")
              return { status: 200, body: await cancelJob(sql, owner, id) };
            if (Number(row.attempt) >= 3)
              throw new ApiError(409, "DRIVE_RETRY_LIMIT");
            const total = (
              await sql.query(
                "SELECT COALESCE(max(e.runs),0) AS runs FROM axfluxo_video.render_jobs j LEFT JOIN axfluxo_video.render_executions e ON e.owner_id=j.owner_id AND e.job_id=j.id WHERE j.owner_id=$1 AND j.batch_id=$2 AND j.range_index=(SELECT range_index FROM axfluxo_video.render_jobs WHERE owner_id=$1 AND id=$3)",
                [owner, row.batch_id, id],
              )
            ).rows[0];
            if (Number(total.runs) >= 3)
              throw new ApiError(409, "DRIVE_RETRY_LIMIT");
            const next = await retryJob(
              sql,
              owner,
              id,
              unitsPerFrame,
              async () => undefined,
            );
            await sql.query(
              "INSERT INTO axfluxo_video.render_executions(owner_id,job_id,runs) VALUES($1,$2,$3)",
              [owner, next.job.id, Number(total.runs)],
            );
            // A batch can contain many ranges. Retry only the original
            // per-job share, not the entire batch peak a second time.
            const originalCount = (
              await sql.query(
                "SELECT count(*)::integer AS total FROM axfluxo_video.render_jobs WHERE owner_id=$1 AND batch_id=$2 AND attempt=1",
                [owner, row.batch_id],
              )
            ).rows[0]?.total;
            if (!Number.isSafeInteger(Number(originalCount)) || Number(originalCount) < 1)
              throw new ApiError(409, "DRIVE_CAPACITY_HELD");
            await reserveJobs(
              sql,
              owner,
              [next.job],
              Math.ceil(Number(row.peak_bytes) / Number(originalCount)),
            );
            return { status: 202, body: next };
          });
        })
        .then((r) => json(r.body, r.status));
    }
    const output = /^\/v1\/drive\/outputs\/([a-f0-9-]+)\/(ticket|saved)$/.exec(
      path,
    );
    if (output && request.method === "POST") {
      const id = z.uuid().parse(output[1]);
      const found = await outputRow(owner, id);
      if (output[2] === "saved") {
        const body = z
          .strictObject({
            versionId: z.string(),
            sha256: z.string(),
            destination: z.enum(["files", "photos"]),
            opened: z.literal(true),
          })
          .parse(await jsonBody(request));
        if (body.versionId !== found.version_id || body.sha256 !== found.hash)
          throw new ApiError(409, "DRIVE_OUTPUT_CHANGED");
        await service.owner(owner, (sql) =>
          sql.query(
            "INSERT INTO axfluxo_video.drive_saved(owner_id,output_id,version_id,hash,destination,opened) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT DO NOTHING",
            [owner, id, body.versionId, body.sha256, body.destination],
          ),
        );
        return json({ saved: true, deleted: false });
      }
      const ticket = secret();
      await service.owner(owner, (sql) =>
        sql.query(
          "INSERT INTO axfluxo_video.drive_tickets(token_hash,owner_id,output_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
          [sha256(ticket), owner, id],
        ),
      );
      return json({
        url: prefix + "/download/" + ticket,
        versionId: found.version_id,
        sha256: found.hash,
        size: Number(found.size),
        expiresIn: 600,
      });
    }
    throw new ApiError(404, "NOT_FOUND");
  }
  async function outputRow(owner: string, id: string) {
    return service.owner(owner, async (sql) => {
      const r = (
        await sql.query(
          "SELECT r.version_id,o.hash,o.size,i.id AS inventory_id,i.file_id FROM axfluxo_video.render_outputs r JOIN axfluxo_video.render_artifacts a ON a.owner_id=r.owner_id AND a.output_id=r.id JOIN axfluxo_video.render_objects o ON o.owner_id=a.owner_id AND o.id=a.object_id JOIN axfluxo_video.drive_inventory i ON i.owner_id=o.owner_id AND i.object_key=o.object_key WHERE r.owner_id=$1 AND r.id=$2 AND o.ready AND i.state='ready' AND o.storage_namespace='drive-v1'",
          [owner, id],
        )
      ).rows[0];
      if (!r) throw new ApiError(404, "NOT_FOUND");
      return r;
    });
  }
  async function download(request: Request): Promise<Response | null> {
    const m = /^\/v1\/drive\/download\/([A-Za-z0-9_-]{43})$/.exec(
      new URL(request.url).pathname,
    );
    if (!m) return null;
    if (!["GET", "HEAD"].includes(request.method))
      throw new ApiError(405, "METHOD_NOT_ALLOWED");
    const ticket = await service.db.transaction(async (sql) => {
      await sql.query("SELECT set_config('axfluxo.drive_ticket',$1,true)", [
        sha256(m[1]),
      ]);
      const row = (
        await sql.query(
          "SELECT owner_id,output_id FROM axfluxo_video.drive_tickets WHERE token_hash=$1 AND expires_at>now()",
          [sha256(m[1])],
        )
      ).rows[0];
      if (!row) throw new ApiError(401, "DRIVE_TICKET_EXPIRED");
      await requireMembership(sql, String(row.owner_id));
      return row;
    });
    const owner = String(ticket.owner_id),
      output = await outputRow(owner, String(ticket.output_id)),
      row = await service.row(owner, String(output.inventory_id));
    return serveInventory(request, owner, row, true);
  }
  async function serveInventory(
    request: Request,
    owner: string,
    row: Inventory,
    attachment: boolean,
  ) {
    await service.remoteIdentity(owner, row);
    const etag = '"' + row.hash + '"',
      size = Number(row.size),
      headers = new Headers({
        "content-type": row.mime,
        "content-disposition": `${attachment ? "attachment" : "inline"}; filename="AxFluxo-${row.id}${attachment ? ".mp4" : ""}"`,
        "cache-control": "no-store",
        "accept-ranges": "bytes",
        etag: etag,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
    let range;
    try {
      range = byteRange(
        !request.headers.has("if-range") ||
          request.headers.get("if-range") === etag
          ? request.headers.get("range")
          : null,
        size,
      );
    } catch {
      headers.set("content-range", "bytes */" + size);
      return new Response(null, { status: 416, headers });
    }
    const length = range ? range.end - range.start + 1 : size;
    headers.set("content-length", String(length));
    if (range)
      headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    if (request.method === "HEAD")
      return new Response(null, { status: range ? 206 : 200, headers });
    const remote = await service
      .transfer(owner)
      .stream(
        row.file_id!,
        request.signal,
        range ? `bytes=${range.start}-${range.end}` : undefined,
        String(row.remote_revision),
      );
    if (
      range &&
      (remote.response.status !== 206 ||
        remote.response.headers.get("content-range") !==
          `bytes ${range.start}-${range.end}/${size}`)
    ) {
      await remote.cancel();
      throw new ApiError(502, "DRIVE_RANGE_INVALID");
    }
    let count = 0;
    async function* checked() {
      try {
        for await (const chunk of remote.body) {
          count += chunk.length;
          if (count > length) throw new ApiError(502, "DRIVE_INTEGRITY_FAILED");
          yield chunk;
        }
        if (count !== length) throw new ApiError(502, "DRIVE_INTEGRITY_FAILED");
      } finally {
        await service.event(owner, "download", count);
      }
    }
    return new Response(
      Readable.toWeb(Readable.from(checked())) as ReadableStream<Uint8Array>,
      { status: range ? 206 : 200, headers },
    );
  }
  async function mediaDownload(request: Request) {
    const m = /^\/v1\/drive\/media\/([A-Za-z0-9_-]{43})$/.exec(
      new URL(request.url).pathname,
    );
    if (!m) return null;
    if (!["GET", "HEAD"].includes(request.method))
      throw new ApiError(405, "METHOD_NOT_ALLOWED");
    const ticket = await service.db.transaction(async (sql) => {
      await sql.query("SELECT set_config('axfluxo.drive_ticket',$1,true)", [
        sha256(m[1]),
      ]);
      const t = (
        await sql.query(
          "SELECT owner_id,object_id FROM axfluxo_video.drive_media_tickets WHERE token_hash=$1 AND expires_at>now()",
          [sha256(m[1])],
        )
      ).rows[0];
      if (!t) throw new ApiError(401, "DRIVE_TICKET_EXPIRED");
      await requireMembership(sql, String(t.owner_id));
      return t;
    });
    const row = await service.row(
      String(ticket.owner_id),
      String(ticket.object_id),
    );
    if (row.state !== "ready") throw new ApiError(409, "DRIVE_NOT_READY");
    return serveInventory(request, String(ticket.owner_id), row, false);
  }
  function cors(request: Request, response: Response | null) {
    if (response) {
      response.headers.set("vary", "Origin");
      response.headers.set(
        "access-control-expose-headers",
        "ETag, Content-Range, Content-Length, Accept-Ranges, Content-Disposition",
      );
      const origin = request.headers.get("origin");
      if (origin) response.headers.set("access-control-allow-origin", origin);
    }
    return response;
  }
  return {
    authenticated: async (request: Request, owner: string) => {
      const r = await handler(request, owner);
      if (r) {
        r.headers.set("vary", "Origin");
        const origin = request.headers.get("origin");
        if (origin) r.headers.set("access-control-allow-origin", origin);
      }
      return r;
    },
    public: async (request: Request) =>
      cors(
        request,
        (await mediaDownload(request)) ?? (await download(request)),
      ),
  };
}
