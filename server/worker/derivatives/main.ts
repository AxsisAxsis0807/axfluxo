import { setTimeout as delay } from "node:timers/promises";
import { postgresDatabase } from "../../db/postgres";
import { serverConfig } from "../../api/config";
import { cloudConfiguration } from "../../storage/config";
import { generatePreview, type DerivedStorage } from "./service";
async function main() {
  const config = serverConfig(process.env),
    cloud = cloudConfiguration(process.env);
  if (!cloud.storage?.putDerived) throw new Error("Unconfigured storage");
  const db = postgresDatabase(
      {
        connectionString: config.databaseUrl,
        ssl: config.production ? { rejectUnauthorized: true } : undefined,
      },
      "axfluxo_video_probe",
    ),
    stop = new AbortController();
  for (const s of ["SIGINT", "SIGTERM"] as const)
    process.once(s, () => stop.abort());
  try {
    while (!stop.signal.aborted) {
      if (cloud.previewEnabled()) {
        const r = await db.transaction((sql) =>
          sql.query(
            "SELECT owner_id,version_id FROM axfluxo_video.media_preview_jobs WHERE state IN ('queued','generating') AND (lease_until IS NULL OR lease_until<now()) LIMIT 10",
          ),
        );
        for (const row of r.rows) {
          if (stop.signal.aborted) break;
          await generatePreview(
            db,
            cloud.storage as DerivedStorage,
            String(row.owner_id),
            String(row.version_id),
          );
        }
      }
      await delay(1000, undefined, { signal: stop.signal }).catch(
        () => undefined,
      );
    }
  } finally {
    await db.close();
  }
}
void main().catch(() => {
  process.stderr.write(
    "Preview worker unavailable. Verify server configuration.\n",
  );
  process.exitCode = 1;
});
