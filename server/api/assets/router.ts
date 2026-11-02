import { z } from "zod";
import { previewAccess } from "./preview";
import {
  displayNameSchema,
  uploadStartSchema,
  partPlanSchema,
} from "../../../src/domain/cloud-library/media";
import type { Database } from "../../db/database";
import type { MultipartStorage } from "../../storage/multipart";
import { jsonBody } from "../app";
import { ApiError } from "../errors";
import { UploadService } from "../uploads/service";
import {
  assets,
  createFolder,
  editAsset,
  folders,
  moveFolder,
  scoped,
} from "./library";
export function cloudRouter(config: {
  db: Database;
  storage: MultipartStorage | null;
  uploadsEnabled: () => boolean;
  previewEnabled?: () => boolean;
  previewUnitsPerSecond?: number;
}) {
  const uploads = config.storage
    ? new UploadService(config.db, config.storage, config.uploadsEnabled)
    : null;
  return async (
    request: Request,
    owner: string,
  ): Promise<{ status: number; body: unknown }> => {
    await scoped(config.db, owner, async () => undefined);
    const url = new URL(request.url),
      path = url.pathname;
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(url.searchParams.get("limit") ?? 50);
    const cursor = url.searchParams.get("cursor");
    if (cursor) z.uuid().parse(cursor);
    const parent = url.searchParams.get("parentId");
    if (parent) z.uuid().parse(parent);
    if (request.method === "GET" && path === "/cloud/folders")
      return {
        status: 200,
        body: await scoped(config.db, owner, (sql) =>
          folders(sql, owner, parent, cursor, page),
        ),
      };
    if (request.method === "POST" && path === "/cloud/folders") {
      const body = z
        .strictObject({
          name: displayNameSchema,
          parentId: z.uuid().nullable(),
        })
        .parse(await jsonBody(request));
      return {
        status: 201,
        body: await scoped(config.db, owner, (sql) =>
          createFolder(sql, owner, body.name, body.parentId),
        ),
      };
    }
    let match = /^\/cloud\/folders\/([^/]+)\/move$/.exec(path);
    if (request.method === "POST" && match) {
      const id = z.uuid().parse(match[1]),
        body = z
          .strictObject({ parentId: z.uuid().nullable() })
          .parse(await jsonBody(request));
      return {
        status: 200,
        body: await scoped(config.db, owner, (sql) =>
          moveFolder(sql, owner, id, body.parentId),
        ),
      };
    }
    if (request.method === "GET" && path === "/cloud/assets") {
      const folder = url.searchParams.get("folderId");
      if (folder) z.uuid().parse(folder);
      return {
        status: 200,
        body: await scoped(config.db, owner, (sql) =>
          assets(
            sql,
            owner,
            folder,
            cursor,
            page,
            url.searchParams.get("deleted") === "true",
          ),
        ),
      };
    }
    match = /^\/cloud\/assets\/([^/]+)\/(rename|move|trash|restore)$/.exec(
      path,
    );
    if (request.method === "POST" && match) {
      const id = z.uuid().parse(match[1]),
        action = match[2];
      const body = await jsonBody(request);
      let edit: { name?: string; folderId?: string | null; deleted?: boolean };
      if (action === "rename")
        edit = z.strictObject({ name: displayNameSchema }).parse(body);
      else if (action === "move")
        edit = z.strictObject({ folderId: z.uuid().nullable() }).parse(body);
      else {
        z.strictObject({}).parse(body);
        edit = { deleted: action === "trash" };
      }
      return {
        status: 200,
        body: await scoped(config.db, owner, (sql) =>
          editAsset(sql, owner, id, edit),
        ),
      };
    }
    const previewMatch = /^\/cloud\/versions\/([^/]+)\/preview$/.exec(path);
    if (request.method === "POST" && previewMatch) {
      z.strictObject({}).parse(await jsonBody(request));
      return {
        status: 200,
        body: await previewAccess(
          {
            db: config.db,
            storage: config.storage,
            enabled: config.previewEnabled ?? (() => false),
            unitsPerSecond: config.previewUnitsPerSecond,
          },
          owner,
          z.uuid().parse(previewMatch[1]),
        ),
      };
    }
    match = /^\/cloud\/versions\/([^/]+)\/access$/.exec(path);
    if (request.method === "GET" && match) {
      if (!config.storage) throw new ApiError(503, "STORAGE_UNAVAILABLE");
      const id = z.uuid().parse(match[1]);
      const row = await scoped(config.db, owner, async (sql) => {
        const r = await sql.query(
          "SELECT v.object_key,v.mime,a.name FROM axfluxo_video.media_versions v JOIN axfluxo_video.media_assets a ON a.owner_id=v.owner_id AND a.id=v.asset_id WHERE v.owner_id=$1 AND v.id=$2",
          [owner, id],
        );
        if (!r.rows.length) throw new ApiError(404, "NOT_FOUND");
        return r.rows[0];
      });
      const signed = await config.storage.access(
        String(row.object_key),
        String(row.mime),
        String(row.name),
      );
      await scoped(config.db, owner, async () => undefined);
      return { status: 200, body: signed };
    }
    if (path === "/cloud/uploads" && request.method === "POST") {
      const body = uploadStartSchema.parse(await jsonBody(request));
      const key = request.headers.get("idempotency-key");
      if (!key || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key))
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
      if (!uploads) throw new ApiError(503, "UPLOADS_DISABLED");
      return { status: 202, body: await uploads.start(owner, body, key) };
    }
    match = /^\/cloud\/uploads\/([^/]+)(?:\/(part|complete|abort))?$/.exec(
      path,
    );
    if (match) {
      const id = z.uuid().parse(match[1]);
      if (!uploads) throw new ApiError(503, "STORAGE_UNAVAILABLE");
      if (request.method === "GET" && !match[2])
        return { status: 200, body: await uploads.status(owner, id) };
      if (request.method === "POST") {
        const body = await jsonBody(request);
        if (match[2] === "part")
          return {
            status: 200,
            body: await uploads.sign(owner, id, partPlanSchema.parse(body)),
          };
        z.strictObject({}).parse(body);
        if (match[2] === "complete")
          return { status: 202, body: await uploads.complete(owner, id) };
        if (match[2] === "abort")
          return { status: 200, body: await uploads.abort(owner, id) };
      }
    }
    throw new ApiError(404, "NOT_FOUND");
  };
}
