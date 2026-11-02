import { postgresDatabase } from "../../db/postgres";
import { deletionStorage } from "./storage";
import { deleteOne } from "./service";
import { setTimeout as delay } from "node:timers/promises";
async function main() {
  if (process.getuid?.() === 0) throw Error("Non-root required");
  if (!process.env.VIDEO_DELETE_DATABASE_URL)
    throw Error("Dedicated database required");
  const db = postgresDatabase(
      {
        connectionString: process.env.VIDEO_DELETE_DATABASE_URL,
        ssl: !["test", "development"].includes(process.env.NODE_ENV ?? "")
          ? { rejectUnauthorized: true }
          : undefined,
      },
      "axfluxo_video_delete",
    ),
    storage = deletionStorage(process.env);
  let stopped = false;
  for (const s of ["SIGTERM", "SIGINT"] as const)
    process.once(s, () => {
      stopped = true;
    });
  try {
    while (!stopped) {
      try {
        await deleteOne(
          db,
          storage,
          () => process.env.VIDEO_DELETE_WORKER_ENABLED === "true",
        );
      } catch {
        /* Ticket retained; no raw storage/SQL errors in logs. */
      }
      if (!stopped) await delay(5000);
    }
  } finally {
    await db.close();
  }
}
void main().catch(() => {
  process.stderr.write("Deletion worker configuration/operation failed.\n");
  process.exitCode = 1;
});
