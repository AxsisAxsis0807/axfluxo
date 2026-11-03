import type { Sql } from "../db/database";
import type { DeveloperServices } from "../contracts/developer-services";
/** Reports configured API capabilities, never claims a worker/provider/device is healthy. No writes. */
export async function developerServices(
  sql: Sql,
  owner: string,
  flags: Partial<DeveloperServices> = {},
): Promise<DeveloperServices> {
  const row = (
    await sql.query(
      `SELECT to_regclass('axfluxo_video.media_versions') IS NOT NULL AS library,to_regclass('axfluxo_video.media_preview_jobs') IS NOT NULL AS preview,to_regclass('axfluxo_video.video_projects') IS NOT NULL AS projects,to_regclass('axfluxo_video.developer_preferences') IS NOT NULL AS preferences,to_regclass('axfluxo_video.render_artifacts') IS NOT NULL AS render,to_regclass('axfluxo_video.output_deletions') IS NOT NULL AS outputs`,
    )
  ).rows[0];
  const budget =
    (
      await sql.query(
        "SELECT owner_id FROM axfluxo_video.usage_budgets WHERE owner_id=$1 AND limit_units IS NOT NULL AND limit_units>reserved_units+consumed_units",
        [owner],
      )
    ).rows.length > 0;
  const cloudLibrary = Boolean(flags.cloudLibrary && row.library),
    preview = Boolean(cloudLibrary && flags.preview && row.preview),
    outputs = Boolean(
      flags.outputs && cloudLibrary && row.outputs && row.render,
    );
  const minimum =
    process.env.VIDEO_OUTPUTS_ENABLED === "true" ||
    process.env.VIDEO_CAPACITY_GUARD_ENABLED === "true"
      ? Number(process.env.VIDEO_CAPACITY_MIN_FREE_BYTES ?? 67108864)
      : 1;
  const quota = Boolean(
    row.library &&
    Number.isSafeInteger(minimum) &&
    minimum > 0 &&
    (
      await sql.query(
        "SELECT owner_id FROM axfluxo_video.media_quotas WHERE owner_id=$1 AND NOT blocked AND limit_bytes IS NOT NULL AND limit_bytes-used_bytes-reserved_bytes>=$2::bigint",
        [owner, minimum],
      )
    ).rows.length,
  );
  const renderAcceptance = Boolean(
    flags.renderAcceptance && cloudLibrary && row.render && budget && quota,
  );
  return {
    cloudLibrary,
    uploads: Boolean(cloudLibrary && flags.uploads && quota),
    preview,
    projects: Boolean(flags.projects && row.projects),
    fnfPreferences: Boolean(flags.fnfPreferences && row.preferences),
    outputs,
    renderAcceptance,
    fnfRenderAcceptance: Boolean(renderAcceptance && flags.fnfRenderAcceptance),
    deleteAcceptance: Boolean(outputs && flags.deleteAcceptance),
    push: Boolean(outputs && flags.push),
  };
}
