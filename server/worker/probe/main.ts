import { setTimeout as delay } from "node:timers/promises";
import { postgresDatabase } from "../../db/postgres";
import { serverConfig } from "../../api/config";
import { cloudConfiguration } from "../../storage/config";
import { UploadService } from "../../api/uploads/service";
import { verifyUpload } from "./verify";
async function main() {
  const config = serverConfig(process.env),
    cloud = cloudConfiguration(process.env);
  if (!cloud.storage) throw new Error("Storage unconfigured");
  const db = postgresDatabase(
      {
        connectionString: config.databaseUrl,
        ssl: config.production ? { rejectUnauthorized: true } : undefined,
      },
      "axfluxo_video_probe",
    ),
    service = new UploadService(db, cloud.storage, () => false),
    stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => stop.abort());
  try {
    while (!stop.signal.aborted) {
      const candidates = await db.transaction((sql) =>
        sql.query(
          "SELECT owner_id,id,state FROM axfluxo_video.upload_sessions WHERE (state IN ('verifying','completing') OR (state IN ('creating','uploading','aborting') AND expires_at<now())) AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 20",
        ),
      );
      for (const row of candidates.rows) {
        if (stop.signal.aborted) break;
        try {
          if (row.state === "completing")
            await service.complete(String(row.owner_id), String(row.id));
          else if (row.state === "verifying")
            await verifyUpload(
              service,
              String(row.owner_id),
              String(row.id),
              stop.signal,
            );
          else await service.abort(String(row.owner_id), String(row.id), true);
        } catch {
          /* Retry durable state later. Never log raw storage errors, keys or URLs. */
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
    "Media verification worker unavailable. Verify server configuration.\n",
  );
  process.exitCode = 1;
});
