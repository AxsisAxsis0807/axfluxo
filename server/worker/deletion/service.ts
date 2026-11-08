import type { Database } from "../../db/database";
import { requireMembership } from "../../api/jobs";
export interface OutputEraser {
  erase(
    key: string,
    size: number,
    hash: string,
    signal?: AbortSignal,
  ): Promise<void>;
}
/** Persistent deleting state freezes new references before network IO. HEAD 404 recovers lost DELETE responses.
 * Temporary objects are retained conservatively: no unproven absence-of-pins garbage collection. */
export async function deleteOne(
  db: Database,
  storage: OutputEraser,
  enabled: () => boolean,
  signal?: AbortSignal,
) {
  if (!enabled() || signal?.aborted) return false;
  const target = await db.transaction(async (sql) => {
    const candidate = (
      await sql.query(
        "SELECT d.owner_id,d.output_id FROM axfluxo_video.output_deletions d JOIN axfluxo_video.developer_memberships m ON m.owner_id=d.owner_id WHERE d.state IN ('pending','deleting','held') AND d.next_at<=now() AND d.reason IS DISTINCT FROM 'LEGACY_STORAGE_RETAINED' AND m.active AND (m.expires_at IS NULL OR m.expires_at>now()) ORDER BY d.confirmed_at LIMIT 1",
      )
    ).rows[0];
    if (!candidate) return null;
    const owner = String(candidate.owner_id);
    await requireMembership(sql, owner);
    const t = (
      await sql.query(
        "SELECT * FROM axfluxo_video.output_deletions WHERE owner_id=$1 AND output_id=$2 AND state<>'deleted' AND next_at<=now() FOR UPDATE SKIP LOCKED",
        [owner, candidate.output_id],
      )
    ).rows[0];
    if (!t) return null;
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `output-version:${owner}:${t.version_id}`,
    ]);
    // Every render/project mutation is serialized against deletion. Signed access is also blocked by the ticket.

    const row = (
      await sql.query(
        `SELECT o.*,r.library_id,r.file_id FROM axfluxo_video.render_objects o JOIN axfluxo_video.render_artifacts a ON a.owner_id=o.owner_id AND a.object_id=o.id JOIN axfluxo_video.render_outputs r ON r.owner_id=a.owner_id AND r.id=a.output_id WHERE o.owner_id=$1 AND o.id=$2 AND r.id=$3 AND r.version_id=$4 AND r.hash=$5 AND o.hash=$5 AND o.ready AND o.kind='output'`,
        [owner, t.object_id, t.output_id, t.version_id, t.hash],
      )
    ).rows[0];
    if (!row || row.storage_namespace !== "outputs-v1")
      throw Error("Output identity unavailable");
    const pinned =
      (
        await sql.query(
          `SELECT 1 FROM axfluxo_video.resource_pins WHERE owner_id=$1 AND version_id=$2 UNION ALL SELECT 1 FROM axfluxo_video.render_artifacts WHERE owner_id=$1 AND object_id=$3 AND output_id<>$4 UNION ALL SELECT 1 FROM axfluxo_video.render_batch_options WHERE owner_id=$1 AND position($2 in project::text)>0 UNION ALL SELECT 1 FROM axfluxo_video.video_projects WHERE owner_id=$1 AND position($2 in project::text)>0 UNION ALL SELECT 1 FROM axfluxo_video.video_project_revisions WHERE owner_id=$1 AND position($2 in project::text)>0 UNION ALL SELECT 1 FROM axfluxo_video.video_project_conflicts WHERE owner_id=$1 AND position($2 in proposed::text)>0 LIMIT 1`,
          [owner, t.version_id, t.object_id, t.output_id],
        )
      ).rows.length > 0;
    if (pinned) {
      await sql.query(
        "UPDATE axfluxo_video.output_deletions SET state='held',reason='RESOURCE_PINNED',next_at=now()+interval '1 hour' WHERE owner_id=$1 AND output_id=$2",
        [owner, t.output_id],
      );
      return null;
    }
    if (!enabled()) return null;
    await sql.query(
      "UPDATE axfluxo_video.output_deletions SET state='deleting',reason=NULL,next_at=now()+interval '60 seconds' WHERE owner_id=$1 AND output_id=$2",
      [owner, t.output_id],
    );
    return {
      owner,
      output: t.output_id,
      key: String(row.object_key),
      size: Number(row.size),
      hash: String(t.hash),
    };
  });
  if (!target) return false;
  signal?.throwIfAborted();
  await storage.erase(target.key, target.size, target.hash, signal);
  return db.transaction(async (sql) => {
    await sql.query("SELECT set_config('axfluxo.owner_id',$1,true)", [
      target.owner,
    ]);
    const row = (
      await sql.query(
        "UPDATE axfluxo_video.output_deletions SET state='deleted',deleted_at=now(),reason=NULL WHERE owner_id=$1 AND output_id=$2 AND state='deleting' RETURNING output_id",
        [target.owner, target.output],
      )
    ).rows[0];
    if (row)
      await sql.query(
        "UPDATE axfluxo_video.media_quotas SET used_bytes=used_bytes-$2::bigint WHERE owner_id=$1",
        [target.owner, target.size],
      );
    return true;
  });
}
