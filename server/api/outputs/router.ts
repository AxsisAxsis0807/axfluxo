import { z } from "zod";
import type { Database, Sql } from "../../db/database";
import type { MultipartStorage } from "../../storage/multipart";
import {
  saveConfirmationSchema,
  pushSubscriptionSchema,
  allowedPushEndpoint,
} from "../../contracts/outputs";
import { requireMembership, idempotent, digest } from "../jobs";
import { ApiError } from "../errors";
import { jsonBody } from "../app";
import { randomUUID } from "node:crypto";
export async function outputAvailable(sql: Sql, owner: string, id: string) {
  const row = (
    await sql.query(
      "SELECT state FROM axfluxo_video.output_deletions WHERE owner_id=$1 AND output_id=$2",
      [owner, id],
    )
  ).rows[0];
  if (row && ["deleting", "deleted"].includes(String(row.state)))
    throw new ApiError(410, "OUTPUT_REMOVED");
}
export function outputsRouter(c: {
  db: Database;
  storage: MultipartStorage | null;
  deletionEnabled: () => boolean;
  pushEnabled: () => boolean;
  vapidPublicKey?: string;
}) {
  return async (request: Request, owner: string) =>
    c.db.transaction(async (sql) => {
      await requireMembership(sql, owner);
      const url = new URL(request.url),
        path = url.pathname;
      if (path === "/outputs" && request.method === "GET") {
        const cursor = url.searchParams.get("cursor");
        if (cursor) z.uuid().parse(cursor);
        const rows = (
          await sql.query(
            `SELECT r.id,r.version_id,r.hash,r.created_at,o.size,d.state,d.reason,d.confirmed_at,
 CASE WHEN b.snapshot->>'kind'='fnf-showcase-snapshot' THEN b.snapshot->'names'->>j.range_index ELSE 'all-versions.mp4' END AS filename
 FROM axfluxo_video.render_outputs r JOIN axfluxo_video.render_artifacts a ON a.owner_id=r.owner_id AND a.output_id=r.id
 JOIN axfluxo_video.render_objects o ON o.owner_id=a.owner_id AND o.id=a.object_id
 JOIN axfluxo_video.render_jobs j ON j.owner_id=r.owner_id AND j.id=r.job_id
 JOIN axfluxo_video.render_batches b ON b.owner_id=j.owner_id AND b.id=j.batch_id
 LEFT JOIN axfluxo_video.output_deletions d ON d.owner_id=r.owner_id AND d.output_id=r.id
 WHERE r.owner_id=$1 AND o.ready AND j.state='succeeded' AND ($2::uuid IS NULL OR r.id<$2) ORDER BY r.id DESC LIMIT 31`,
            [owner, cursor],
          )
        ).rows;
        return {
          status: 200,
          body: {
            items: rows.slice(0, 30).map((r) => ({
              id: r.id,
              versionId: r.version_id,
              hash: r.hash,
              size: Number(r.size),
              createdAt: new Date(String(r.created_at)).toISOString(),
              filename: r.filename ?? "output.mp4",
              state: r.state ?? "unconfirmed",
              reason: r.reason ?? null,
              unconfirmed30Days:
                !r.confirmed_at &&
                Date.now() - new Date(String(r.created_at)).getTime() >=
                  30 * 86400000,
            })),
            nextCursor: rows.length > 30 ? rows[29].id : null,
          },
        };
      }
      const confirm = /^\/outputs\/([^/]+)\/confirm-saved$/.exec(path);
      if (confirm && request.method === "POST") {
        const id = z.uuid().parse(confirm[1]),
          body = saveConfirmationSchema.parse(await jsonBody(request)),
          key = request.headers.get("idempotency-key");
        if (!key || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key))
          throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
        return idempotent(sql, owner, key, digest({ path, body }), async () => {
          if (!c.deletionEnabled())
            throw new ApiError(503, "DELETION_DISABLED");
          const r = (
            await sql.query(
              `SELECT r.version_id,r.hash,a.object_id,o.storage_namespace FROM axfluxo_video.render_outputs r JOIN axfluxo_video.render_artifacts a ON a.owner_id=r.owner_id AND a.output_id=r.id JOIN axfluxo_video.render_objects o ON o.owner_id=a.owner_id AND o.id=a.object_id JOIN axfluxo_video.render_jobs j ON j.owner_id=r.owner_id AND j.id=r.job_id WHERE r.owner_id=$1 AND r.id=$2 AND o.ready AND j.state='succeeded'`,
              [owner, id],
            )
          ).rows[0];
          if (!r) throw new ApiError(404, "NOT_FOUND");
          if (r.version_id !== body.versionId || r.hash !== body.hash)
            throw new ApiError(409, "OUTPUT_IDENTITY_CHANGED");
          const legacy = r.storage_namespace !== "outputs-v1";
          await sql.query(
            "INSERT INTO axfluxo_video.output_deletions(owner_id,output_id,object_id,version_id,hash,photo_library_checked,state,reason) VALUES($1,$2,$3,$4,$5,true,$6,$7) ON CONFLICT(owner_id,output_id) DO NOTHING",
            [
              owner,
              id,
              r.object_id,
              body.versionId,
              body.hash,
              legacy ? "held" : "pending",
              legacy ? "LEGACY_STORAGE_RETAINED" : null,
            ],
          );
          return {
            status: 202,
            body: {
              outputId: id,
              state: (
                await sql.query(
                  "SELECT state FROM axfluxo_video.output_deletions WHERE owner_id=$1 AND output_id=$2",
                  [owner, id],
                )
              ).rows[0].state,
            },
          };
        });
      }
      if (path === "/push/config" && request.method === "GET")
        return {
          status: 200,
          body: {
            enabled: c.pushEnabled() && Boolean(c.vapidPublicKey),
            publicKey: c.pushEnabled() ? (c.vapidPublicKey ?? null) : null,
          },
        };
      if (path === "/push/subscribe" && request.method === "POST") {
        if (!c.pushEnabled()) throw new ApiError(503, "PUSH_DISABLED");
        const sub = pushSubscriptionSchema.parse(await jsonBody(request));
        if (!allowedPushEndpoint(sub.endpoint))
          throw new ApiError(400, "VALIDATION_FAILED");
        const hash = digest(sub.endpoint);
        await sql.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [hash],
        );
        // Global unique endpoint protects a subscription already attached to another owner; errors stay private.
        const registered = await sql
          .query(
            "INSERT INTO axfluxo_video.push_subscriptions(id,owner_id,endpoint_hash,subscription) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(endpoint_hash) DO UPDATE SET subscription=EXCLUDED.subscription,active=true WHERE axfluxo_video.push_subscriptions.owner_id=EXCLUDED.owner_id RETURNING id",
            [randomUUID(), owner, hash, JSON.stringify(sub)],
          )
          .catch((error: unknown) => {
            if (
              ["42501", "23505"].includes(
                String((error as { code?: string }).code),
              )
            )
              throw new ApiError(409, "PUSH_SUBSCRIPTION_OWNED");
            throw error;
          });
        if (registered.rows.length !== 1)
          throw new ApiError(409, "PUSH_SUBSCRIPTION_OWNED");
        return { status: 200, body: { subscribed: true } };
      }
      if (path === "/push/unsubscribe" && request.method === "POST") {
        const body = z
          .strictObject({ endpoint: z.url() })
          .parse(await jsonBody(request));
        await sql.query(
          "UPDATE axfluxo_video.push_subscriptions SET active=false WHERE owner_id=$1 AND endpoint_hash=$2",
          [owner, digest(body.endpoint)],
        );
        return { status: 200, body: { subscribed: false } };
      }
      throw new ApiError(404, "NOT_FOUND");
    });
}
