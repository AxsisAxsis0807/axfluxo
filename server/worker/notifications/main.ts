import webpush from "web-push";
import { postgresDatabase } from "../../db/postgres";
import { notifyOneOwner } from "./service";
import { setTimeout as delay } from "node:timers/promises";
async function main() {
  if (process.getuid?.() === 0 || !process.env.VIDEO_NOTIFY_DATABASE_URL)
    throw Error("Dedicated non-root worker required");
  webpush.setVapidDetails(
    process.env.VIDEO_VAPID_SUBJECT ?? "",
    process.env.VIDEO_VAPID_PUBLIC_KEY ?? "",
    process.env.VIDEO_VAPID_PRIVATE_KEY ?? "",
  );
  const db = postgresDatabase(
    {
      connectionString: process.env.VIDEO_NOTIFY_DATABASE_URL,
      ssl: !["test", "development"].includes(process.env.NODE_ENV ?? "")
        ? { rejectUnauthorized: true }
        : undefined,
    },
    "axfluxo_video_notify",
  );
  let stopped = false;
  for (const s of ["SIGTERM", "SIGINT"] as const)
    process.once(s, () => {
      stopped = true;
    });
  try {
    while (!stopped) {
      if (process.env.VIDEO_PUSH_ENABLED === "true") {
        const owners = await db.transaction((sql) =>
          sql.query(
            "SELECT DISTINCT owner_id FROM axfluxo_video.push_subscriptions WHERE active",
          ),
        );
        for (const r of owners.rows)
          try {
            await notifyOneOwner(
              db,
              String(r.owner_id),
              (sub, payload) =>
                webpush
                  .sendNotification(sub, payload, { TTL: 86400, timeout: 3000 })
                  .then(() => undefined),
              () => process.env.VIDEO_PUSH_ENABLED === "true",
            );
          } catch {
            /* Render results remain immutable. */
          }
      }
      if (!stopped) await delay(5000);
    }
  } finally {
    await db.close();
  }
}
void main().catch(() => {
  process.stderr.write("Notification worker configuration/operation failed.\n");
  process.exitCode = 1;
});
