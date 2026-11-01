import { randomUUID } from "node:crypto";
import type { Database, Sql } from "../../db/database";
import { requireMembership } from "../jobs";
import { ApiError } from "../errors";
export function scoped<T>(
  db: Database,
  owner: string,
  work: (sql: Sql) => Promise<T>,
): Promise<T> {
  return db.transaction(async (sql) => {
    await requireMembership(sql, owner);
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      owner,
    ]);
    return work(sql);
  });
}
export async function folderOwned(sql: Sql, owner: string, id: string | null) {
  if (id === null) return;
  const r = await sql.query(
    "SELECT id FROM axfluxo_video.media_folders WHERE owner_id=$1 AND id=$2",
    [owner, id],
  );
  if (!r.rows.length) throw new ApiError(404, "NOT_FOUND");
}
export async function ensureRoots(sql: Sql, owner: string) {
  for (const [key, name] of [
    ["all-versions", "All Versions Video Maker"],
    ["fnf-showcase", "FNF Showcase Maker"],
  ])
    await sql.query(
      "INSERT INTO axfluxo_video.media_folders(id,owner_id,name,system_key) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,system_key) DO NOTHING",
      [randomUUID(), owner, name, key],
    );
}
export async function folders(
  sql: Sql,
  owner: string,
  parent: string | null,
  cursor: string | null,
  limit: number,
) {
  await ensureRoots(sql, owner);
  await folderOwned(sql, owner, parent);
  const r = await sql.query(
    `SELECT id,parent_id AS "parentId",name,system_key AS "systemKey" FROM axfluxo_video.media_folders WHERE owner_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,
    [owner, parent, cursor, limit + 1],
  );
  return {
    items: r.rows.slice(0, limit),
    nextCursor: r.rows.length > limit ? r.rows[limit - 1].id : null,
  };
}
export async function createFolder(
  sql: Sql,
  owner: string,
  name: string,
  parent: string | null,
) {
  await folderOwned(sql, owner, parent);
  const id = randomUUID();
  await sql.query(
    "INSERT INTO axfluxo_video.media_folders(id,owner_id,name,parent_id) VALUES($1,$2,$3,$4)",
    [id, owner, name, parent],
  );
  return { id, parentId: parent, name, systemKey: null };
}
export async function moveFolder(
  sql: Sql,
  owner: string,
  id: string,
  parent: string | null,
) {
  const r = await sql.query(
    "SELECT system_key FROM axfluxo_video.media_folders WHERE owner_id=$1 AND id=$2",
    [owner, id],
  );
  if (!r.rows.length) throw new ApiError(404, "NOT_FOUND");
  if (r.rows[0].system_key) throw new ApiError(409, "SYSTEM_FOLDER");
  await folderOwned(sql, owner, parent);
  if (parent) {
    const ancestors = await sql.query(
      `WITH RECURSIVE ancestors AS (SELECT id,parent_id FROM axfluxo_video.media_folders WHERE owner_id=$1 AND id=$2 UNION SELECT f.id,f.parent_id FROM axfluxo_video.media_folders f JOIN ancestors a ON f.id=a.parent_id WHERE f.owner_id=$1) SELECT id FROM ancestors WHERE id=$3`,
      [owner, parent, id],
    );
    if (ancestors.rows.length) throw new ApiError(409, "FOLDER_CYCLE");
  }
  await sql.query(
    "UPDATE axfluxo_video.media_folders SET parent_id=$3 WHERE owner_id=$1 AND id=$2",
    [owner, id, parent],
  );
  return { id };
}
export async function assets(
  sql: Sql,
  owner: string,
  folder: string | null,
  cursor: string | null,
  limit: number,
  deleted: boolean,
) {
  await folderOwned(sql, owner, folder);
  const r = await sql.query(
    `SELECT a.id,a.folder_id AS "folderId",a.name,a.deleted,v.id AS "versionId",v.hash,v.kind,v.mime,v.size FROM axfluxo_video.media_assets a JOIN axfluxo_video.media_versions v ON v.owner_id=a.owner_id AND v.asset_id=a.id WHERE a.owner_id=$1 AND a.folder_id IS NOT DISTINCT FROM $2::uuid AND a.deleted=$3 AND ($4::uuid IS NULL OR a.id>$4) ORDER BY a.id LIMIT $5`,
    [owner, folder, deleted, cursor, limit + 1],
  );
  return {
    items: r.rows.slice(0, limit).map((v) => ({ ...v, size: Number(v.size) })),
    nextCursor: r.rows.length > limit ? r.rows[limit - 1].id : null,
  };
}
export async function editAsset(
  sql: Sql,
  owner: string,
  id: string,
  edit: { name?: string; folderId?: string | null; deleted?: boolean },
) {
  if (edit.folderId !== undefined) await folderOwned(sql, owner, edit.folderId);
  const r = await sql.query(
    "UPDATE axfluxo_video.media_assets SET name=coalesce($3,name),folder_id=CASE WHEN $4 THEN $5::uuid ELSE folder_id END,deleted=coalesce($6,deleted) WHERE owner_id=$1 AND id=$2 RETURNING id",
    [
      owner,
      id,
      edit.name ?? null,
      edit.folderId !== undefined,
      edit.folderId ?? null,
      edit.deleted ?? null,
    ],
  );
  if (!r.rows.length) throw new ApiError(404, "NOT_FOUND");
  return { id };
}
