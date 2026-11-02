import { previewInfoSchema } from "../../../src/domain/video/preview";
import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database";
import type { MultipartStorage } from "../../storage/multipart";
import { scoped } from "./library";
import { ApiError } from "../errors";
export async function previewAccess(
  config: {
    db: Database;
    storage: MultipartStorage | null;
    enabled: () => boolean;
    unitsPerSecond?: number;
  },
  owner: string,
  id: string,
) {
  const data = await scoped(config.db, owner, async (sql) => {
    const version = (
      await sql.query(
        "SELECT * FROM axfluxo_video.media_versions WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    if (!version) throw new ApiError(404, "SOURCE_MISSING");
    if (!["video", "audio"].includes(String(version.kind)))
      throw new ApiError(422, "PREVIEW_FAILED");
    let job = (
      await sql.query(
        "SELECT * FROM axfluxo_video.media_preview_jobs WHERE owner_id=$1 AND version_id=$2",
        [owner, id],
      )
    ).rows[0];
    if (!job && config.enabled()) {
      if (
        !Number.isSafeInteger(config.unitsPerSecond) ||
        !config.unitsPerSecond ||
        config.unitsPerSecond < 1 ||
        config.unitsPerSecond > 1000000
      )
        throw new ApiError(503, "PROXY_NOT_READY");
      const duration = (version.probe as { durationUs: number }).durationUs,
        units =
          ((BigInt(duration) + 999999n) / 1000000n) *
          BigInt(config.unitsPerSecond);
      const reserved = await sql.query(
        "UPDATE axfluxo_video.usage_budgets SET reserved_units=reserved_units+$2::bigint WHERE owner_id=$1 AND limit_units IS NOT NULL AND $2::bigint<=limit_units-reserved_units-consumed_units RETURNING owner_id",
        [owner, units.toString()],
      );
      if (!reserved.rows.length) throw new ApiError(503, "PROXY_NOT_READY");
      job = (
        await sql.query(
          "INSERT INTO axfluxo_video.media_preview_jobs(id,owner_id,version_id,compute_units) VALUES($1,$2,$3,$4) RETURNING *",
          [randomUUID(), owner, id, units.toString()],
        )
      ).rows[0];
    }
    return { version, job };
  });
  if (!data.job || data.job.state !== "ready")
    throw new ApiError(
      409,
      data.job?.state === "failed"
        ? String(data.job.error_code ?? "PREVIEW_FAILED")
        : "PROXY_NOT_READY",
    );
  if (!config.storage) throw new ApiError(503, "PROXY_NOT_READY");
  if (!(await config.storage.head(String(data.version.object_key))))
    throw new ApiError(404, "SOURCE_MISSING");
  const plan = data.job.plan as {
    files: { kind: string; key: string; mime: string }[];
  };
  const urls: Record<string, string> = {};
  for (const f of plan.files)
    urls[f.kind] = (await config.storage.access(f.key, f.mime, f.kind)).url;
  await scoped(config.db, owner, async () => undefined);
  return previewInfoSchema.parse({
    versionId: id,
    assetId: data.version.asset_id,
    hash: data.version.hash,
    ...(data.job.metadata as object),
    ...urls,
    expiresAt: Date.now() + 60000,
  });
}
