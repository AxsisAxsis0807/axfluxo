import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  allVersionsProjectSchema,
  projectIssues,
} from "../../../src/domain/video/all-versions";
import { fnfSnapshotSchema } from "../../../src/domain/video/schema";
import type { Database, Sql } from "../../db/database";
import { createBatch, digest, idempotent, requireMembership } from "../jobs";
import { ApiError } from "../errors";
import { jsonBody } from "../app";
import { textImage } from "../../worker/templates/all-versions/graphics";
async function resources(
  sql: Sql,
  owner: string,
  project: z.infer<typeof allVersionsProjectSchema>,
) {
  for (const r of [
    ...(project.document?.clips.map((c) => c.source) ?? []),
    ...(project.cover ? [project.cover] : []),
  ]) {
    if (
      !(
        await sql.query(
          "SELECT version_id FROM axfluxo_video.resource_versions WHERE owner_id=$1 AND library_id=$2 AND file_id=$3 AND version_id=$4 AND hash=$5 AND kind=$6",
          [owner, r.libraryId, r.fileId, r.versionId, r.hash, r.kind],
        )
      ).rows.length
    )
      throw new ApiError(404, "RESOURCE_NOT_FOUND");
  }
}
export function projectsRouter(config: {
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
    const match = /^\/projects\/([a-f0-9-]+)(\/render)?$/.exec(path);
    if (path === "/projects/text-preview" && request.method === "POST") {
      const body = z
        .strictObject({
          project: allVersionsProjectSchema,
          index: z.number().int().nonnegative(),
        })
        .parse(await jsonBody(request));
      await config.db.transaction((sql) => requireMembership(sql, owner));
      const image = await textImage(body.project, body.index);
      await config.db.transaction((sql) => requireMembership(sql, owner));
      return {
        status: 200,
        body: { ...image, png: image.png.toString("base64") },
      };
    }
    if (!match) throw new ApiError(404, "NOT_FOUND");
    const id = z.uuid().parse(match[1]);
    return config.db.transaction(async (sql) => {
      await requireMembership(sql, owner);
      if (request.method === "GET" && !match[2]) {
        const row = (
          await sql.query(
            "SELECT project,revision FROM axfluxo_video.video_projects WHERE owner_id=$1 AND id=$2",
            [owner, id],
          )
        ).rows[0];
        if (!row) throw new ApiError(404, "PROJECT_NOT_FOUND");
        return {
          status: 200,
          body: { project: row.project, revision: Number(row.revision) },
        };
      }
      if (request.method !== "POST") throw new ApiError(404, "NOT_FOUND");
      const key = request.headers.get("idempotency-key"),
        etag = request.headers.get("if-match");
      if (!key || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key))
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
      if (
        !etag ||
        !/^"\d+"$/.test(etag) ||
        !Number.isSafeInteger(Number(etag.slice(1, -1)))
      )
        throw new ApiError(428, "IF_MATCH_REQUIRED");
      const expected = Number(etag.slice(1, -1)),
        body = await jsonBody(request);
      return idempotent(
        sql,
        owner,
        key,
        digest({ path, body, expected }),
        async () => {
          await sql.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`${owner}:${id}`],
          );
          const old = (
            await sql.query(
              "SELECT project,revision FROM axfluxo_video.video_projects WHERE owner_id=$1 AND id=$2 FOR UPDATE",
              [owner, id],
            )
          ).rows[0];
          if (match[2]) {
            if (!old) throw new ApiError(404, "PROJECT_NOT_FOUND");
            if (Number(old.revision) !== expected)
              return {
                status: 409,
                body: {
                  error: { code: "PROJECT_CONFLICT" },
                  project: old.project,
                  revision: Number(old.revision),
                },
              };
            z.strictObject({}).parse(body);
            if (!config.enabled()) throw new ApiError(503, "ADMISSION_CLOSED");
            const project = allVersionsProjectSchema.parse(old.project);
            if (projectIssues(project).length)
              throw new ApiError(422, "PROJECT_INVALID");
            await resources(sql, owner, project);
            const duration = project.document!.clips.reduce(
                (n, c) => n + c.interval.endUs - c.interval.startUs,
                0,
              ),
              snapshot = fnfSnapshotSchema.parse({
                schemaVersion: 1,
                id: randomUUID(),
                document: project.document,
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
            return { status: 202, body: batch };
          }
          const project = allVersionsProjectSchema.parse(body);
          if (project.id !== id) throw new ApiError(400, "VALIDATION_FAILED");
          await resources(sql, owner, project);
          if (Number(old?.revision ?? 0) !== expected) {
            if (old)
              await sql.query(
                "INSERT INTO axfluxo_video.video_project_conflicts(id,owner_id,project_id,expected_revision,current_revision,proposed) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
                [
                  randomUUID(),
                  owner,
                  id,
                  expected,
                  old.revision,
                  JSON.stringify(project),
                ],
              );
            return {
              status: 409,
              body: {
                error: { code: "PROJECT_CONFLICT" },
                project: old?.project ?? null,
                revision: Number(old?.revision ?? 0),
              },
            };
          }
          await sql.query(
            "INSERT INTO axfluxo_video.video_projects(owner_id,id,revision,project) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner_id,id) DO UPDATE SET revision=EXCLUDED.revision,project=EXCLUDED.project",
            [owner, id, expected + 1, JSON.stringify(project)],
          );
          await sql.query(
            "INSERT INTO axfluxo_video.video_project_revisions(owner_id,project_id,revision,project) VALUES($1,$2,$3,$4::jsonb)",
            [owner, id, expected + 1, JSON.stringify(project)],
          );
          return { status: 200, body: { revision: expected + 1, project } };
        },
      );
    });
  };
}
