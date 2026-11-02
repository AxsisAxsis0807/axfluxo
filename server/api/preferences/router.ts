import { z } from "zod";
import {
  fnfPreferencesSchema,
  fnfShowcaseSnapshotSchema,
  defaultFnfPreferences,
  isFnfShowcase,
} from "../../../src/domain/video/fnf-showcase";
import type { Database } from "../../db/database";
import {
  requireMembership,
  idempotent,
  digest,
  createBatch,
  getBatch,
} from "../jobs";
import { RenderError } from "../../worker/jobs/errors";
import { ApiError } from "../errors";
import { jsonBody } from "../app";
import {
  fnfOverlay,
  gameplayGeometry,
} from "../../worker/templates/fnf-showcase/render";
function publicError(error: unknown): never {
  if (error instanceof RenderError)
    throw new ApiError(
      error.code === "FNF_FONT_UNAVAILABLE" || error.code === "RESOURCE_LIMIT"
        ? 503
        : 422,
      error.code,
    );
  throw error;
}
export function fnfRouter(config: {
  db: Database;
  enabled: () => boolean;
  unitsPerFrame?: number;
}) {
  return async (request: Request, owner: string) => {
    if (
      request.headers.has("x-project-owner") &&
      request.headers.get("x-project-owner") !== owner
    )
      throw new ApiError(403, "DEVELOPER_REQUIRED");
    const url = new URL(request.url),
      path = url.pathname;
    if (path === "/fnf-showcase/overlay" && request.method === "POST") {
      const preferences = fnfPreferencesSchema.parse(await jsonBody(request));
      await config.db.transaction((sql) => requireMembership(sql, owner));
      const image = await fnfOverlay(preferences).catch(publicError);
      await config.db.transaction((sql) => requireMembership(sql, owner));
      return {
        status: 200,
        body: { ...image, png: image.png.toString("base64") },
      };
    }
    return config.db.transaction(async (sql) => {
      await requireMembership(sql, owner);
      if (path === "/preferences/fnf-showcase" && request.method === "GET") {
        const row = (
          await sql.query(
            "SELECT preferences,revision FROM axfluxo_video.developer_preferences WHERE owner_id=$1 AND kind='fnf-showcase'",
            [owner],
          )
        ).rows[0];
        return {
          status: 200,
          body: {
            preferences: row?.preferences ?? defaultFnfPreferences(),
            revision: Number(row?.revision ?? 0),
          },
        };
      }
      const source = /^\/fnf-showcase\/source\/([^/]+)$/.exec(path);
      if (source && request.method === "GET") {
        const id = z.uuid().parse(source[1]),
          row = (
            await sql.query(
              "SELECT v.id,v.asset_id,v.hash,v.probe FROM axfluxo_video.media_versions v WHERE v.owner_id=$1 AND v.id=$2 AND v.kind='video'",
              [owner, id],
            )
          ).rows[0];
        if (!row) throw new ApiError(404, "FNF_SOURCE_MISSING");
        const metadata = row.probe as Record<string, unknown>;
        const durationUs = z
            .number()
            .int()
            .positive()
            .parse(metadata.durationUs),
          width = z
            .number()
            .int()
            .positive()
            .parse(metadata.displayWidth ?? metadata.width),
          height = z
            .number()
            .int()
            .positive()
            .parse(metadata.displayHeight ?? metadata.height);
        return {
          status: 200,
          body: {
            reference: {
              libraryId: "cloud",
              fileId: String(row.asset_id),
              versionId: String(row.id),
              hash: String(row.hash),
              kind: "video",
            },
            durationUs,
            width,
            height,
            geometryVerified:
              typeof metadata.displayWidth === "number" &&
              typeof metadata.displayHeight === "number",
          },
        };
      }
      if (path === "/fnf-showcase/batches" && request.method === "GET") {
        const cursor = url.searchParams.get("cursor");
        if (cursor) z.uuid().parse(cursor);
        const rows = (
          await sql.query(
            "SELECT id,created_at FROM axfluxo_video.render_batches WHERE owner_id=$1 AND snapshot->>'kind'='fnf-showcase-snapshot' AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT 31",
            [owner, cursor],
          )
        ).rows;
        return {
          status: 200,
          body: {
            items: rows.slice(0, 30).map((r) => ({
              id: r.id,
              createdAt: new Date(String(r.created_at)).toISOString(),
            })),
            nextCursor: rows.length > 30 ? rows[29].id : null,
          },
        };
      }
      const batch = /^\/fnf-showcase\/batches\/([^/]+)$/.exec(path);
      if (batch && request.method === "GET") {
        const id = z.uuid().parse(batch[1]),
          row = (
            await sql.query(
              "SELECT snapshot FROM axfluxo_video.render_batches WHERE owner_id=$1 AND id=$2",
              [owner, id],
            )
          ).rows[0];
        if (!row || !isFnfShowcase(row.snapshot))
          throw new ApiError(404, "NOT_FOUND");
        const snapshot = fnfShowcaseSnapshotSchema.parse(row.snapshot);
        return {
          status: 200,
          body: {
            batch: await getBatch(sql, owner, id),
            items: snapshot.ranges.map((r, i) => ({
              ...r,
              rangeIndex: i,
              chartName: snapshot.chartNames[i],
              filename: snapshot.names[i],
            })),
          },
        };
      }
      if (
        request.method !== "POST" ||
        !["/preferences/fnf-showcase", "/fnf-showcase/batches"].includes(path)
      )
        throw new ApiError(404, "NOT_FOUND");
      const body = await jsonBody(request),
        key = request.headers.get("idempotency-key");
      if (!key || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key))
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
      if (path === "/preferences/fnf-showcase") {
        const preferences = fnfPreferencesSchema.parse(body),
          etag = request.headers.get("if-match");
        if (
          !etag ||
          !/^"\d+"$/.test(etag) ||
          !Number.isSafeInteger(Number(etag.slice(1, -1)))
        )
          throw new ApiError(428, "IF_MATCH_REQUIRED");
        const expected = Number(etag.slice(1, -1));
        return idempotent(
          sql,
          owner,
          key,
          digest({ path, preferences, expected }),
          async () => {
            await sql.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
              [`fnf-preferences:${owner}`],
            );
            const old = (
              await sql.query(
                "SELECT revision,preferences FROM axfluxo_video.developer_preferences WHERE owner_id=$1 AND kind='fnf-showcase' FOR UPDATE",
                [owner],
              )
            ).rows[0];
            if (Number(old?.revision ?? 0) !== expected)
              return {
                status: 409,
                body: { error: { code: "FNF_PREFERENCES_CONFLICT" } },
              };
            await sql.query(
              "INSERT INTO axfluxo_video.developer_preferences(owner_id,kind,revision,preferences) VALUES($1,'fnf-showcase',$2,$3::jsonb) ON CONFLICT(owner_id,kind) DO UPDATE SET revision=EXCLUDED.revision,preferences=EXCLUDED.preferences",
              [owner, expected + 1, JSON.stringify(preferences)],
            );
            return {
              status: 200,
              body: { revision: expected + 1, preferences },
            };
          },
        );
      }
      const snapshot = fnfShowcaseSnapshotSchema.parse(body);
      return idempotent(
        sql,
        owner,
        key,
        digest({ path, snapshot }),
        async () => {
          if (!config.enabled()) throw new ApiError(503, "ADMISSION_CLOSED");
          const ref = snapshot.document.clips[0].source;
          const row = (
            await sql.query(
              "SELECT probe FROM axfluxo_video.media_versions WHERE owner_id=$1 AND id::text=$2 AND asset_id::text=$3 AND hash=$4 AND kind='video'",
              [owner, ref.versionId, ref.fileId, ref.hash],
            )
          ).rows[0];
          if (!row) throw new ApiError(404, "FNF_SOURCE_MISSING");
          const info = row.probe as Record<string, unknown>;
          if (
            Number(info.durationUs) !==
            snapshot.document.clips[0].sourceDurationUs
          )
            throw new ApiError(422, "FNF_INVALID_SNAPSHOT");
          try {
            gameplayGeometry(snapshot.preferences, {
              width: Number(info.displayWidth ?? info.width),
              height: Number(info.displayHeight ?? info.height),
            });
          } catch (error) {
            publicError(error);
          }
          return {
            status: 202,
            body: await createBatch(sql, owner, snapshot, config.unitsPerFrame),
          };
        },
      );
    });
  };
}
