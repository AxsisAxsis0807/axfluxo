import { setTimeout as delay } from "node:timers/promises";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { postgresDatabase } from "../../db/postgres";
import { cloudConfiguration } from "../../storage/config";
import { claim } from "../jobs/queue";
import { executeRender } from "./service";
import type { RenderStorage } from "./objects";
export function renderConfiguration(env: Record<string, string | undefined>) {
  const directory = env.VIDEO_RENDER_DISK;
  const maxWorkBytes = Number(env.VIDEO_RENDER_MAX_WORK_BYTES),
    minFreeBytes = Number(env.VIDEO_RENDER_MIN_FREE_BYTES ?? 536870912);
  if (
    !directory ||
    !isAbsolute(directory) ||
    !Number.isSafeInteger(maxWorkBytes) ||
    maxWorkBytes < 1024 ** 3 ||
    !Number.isSafeInteger(minFreeBytes) ||
    minFreeBytes < 64 * 1024 ** 2
  )
    throw new Error("Unconfigured render resources");
  if (!env.VIDEO_DATABASE_URL) throw new Error("Unconfigured database");
  const database = new URL(env.VIDEO_DATABASE_URL);
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    database.search ||
    database.hash
  )
    throw new Error("Invalid database");
  return {
    directory,
    maxWorkBytes,
    minFreeBytes,
    databaseUrl: database.toString(),
    production: !["test", "development"].includes(env.NODE_ENV ?? ""),
    enabled: () => env.VIDEO_RENDER_ENABLED === "true",
  };
}
async function main() {
  if (process.getuid?.() === 0) throw new Error("Root worker forbidden");
  const config = renderConfiguration(process.env),
    cloud = cloudConfiguration(process.env);
  if (!cloud.storage?.putRender) throw new Error("Unconfigured render storage");
  await access(config.directory);
  const db = postgresDatabase(
    {
      connectionString: config.databaseUrl,
      ssl: config.production ? { rejectUnauthorized: true } : undefined,
    },
    "axfluxo_video_render",
  );
  let draining = false;
  for (const s of ["SIGINT", "SIGTERM"] as const)
    process.once(s, () => {
      draining = true;
    });
  try {
    while (!draining) {
      if (config.enabled()) {
        const c = await claim(db);
        if (c)
          await executeRender(db, cloud.storage as RenderStorage, c, config);
      }
      if (!draining) await delay(1000);
    }
  } finally {
    await db.close();
  }
}
// Importing config in tests must not start a worker.
if (
  process.argv[1]?.endsWith("/render.mjs") ||
  process.argv[1]?.endsWith("/render/main.ts")
)
  void main().catch(() => {
    process.stderr.write(
      "Render worker unavailable. Verify resource and server configuration.\n",
    );
    process.exitCode = 1;
  });
