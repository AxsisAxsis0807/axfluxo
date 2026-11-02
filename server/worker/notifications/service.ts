import type { Database } from "../../db/database";
import { requireMembership, digest } from "../../api/jobs";
import {
  allowedPushEndpoint,
  pushSubscriptionSchema,
} from "../../contracts/outputs";
export type PushSender = (
  subscription: ReturnType<typeof pushSubscriptionSchema.parse>,
  payload: string,
) => Promise<void>;
export function batchCompletion(
  jobs: { id: string; range_index: number; attempt: number; state: string }[],
) {
  const latest = new Map<number, (typeof jobs)[number]>();
  for (const j of jobs)
    if (
      !latest.has(j.range_index) ||
      latest.get(j.range_index)!.attempt < j.attempt
    )
      latest.set(j.range_index, j);
  const items = [...latest.values()].sort(
    (a, b) => a.range_index - b.range_index,
  );
  if (
    !items.length ||
    items.some(
      (j) =>
        !["succeeded", "failed", "interrupted", "cancelled"].includes(j.state),
    )
  )
    return null;
  const successes = items.filter((j) => j.state === "succeeded").length;
  return {
    fingerprint: digest(items),
    kind:
      successes === items.length
        ? "completed"
        : successes
          ? "partial_failed"
          : "failed",
  };
}
/** Durable delivery ledger. A transport failure never changes any render state. */
export async function notifyOneOwner(
  db: Database,
  owner: string,
  send: PushSender,
  enabled: () => boolean,
) {
  if (!enabled()) return;
  await db.transaction(async (sql) => {
    await requireMembership(sql, owner);
    const batches = (
      await sql.query(
        "SELECT id FROM axfluxo_video.render_batches WHERE owner_id=$1",
        [owner],
      )
    ).rows;
    const subs = (
      await sql.query(
        "SELECT id,subscription FROM axfluxo_video.push_subscriptions WHERE owner_id=$1 AND active",
        [owner],
      )
    ).rows;
    for (const b of batches) {
      const jobs = (
        await sql.query(
          "SELECT id,range_index,attempt,state FROM axfluxo_video.render_jobs WHERE owner_id=$1 AND batch_id=$2 ORDER BY range_index,attempt",
          [owner, b.id],
        )
      ).rows as {
        id: string;
        range_index: number;
        attempt: number;
        state: string;
      }[];
      const done = batchCompletion(jobs);
      if (!done) continue;
      for (const sub of subs) {
        await sql.query(
          "INSERT INTO axfluxo_video.notification_deliveries(owner_id,batch_id,fingerprint,subscription_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [owner, b.id, done.fingerprint, sub.id],
        );
        const delivery = (
          await sql.query(
            "SELECT * FROM axfluxo_video.notification_deliveries WHERE owner_id=$1 AND batch_id=$2 AND fingerprint=$3 AND subscription_id=$4 AND state='pending' AND next_at<=now() FOR UPDATE SKIP LOCKED",
            [owner, b.id, done.fingerprint, sub.id],
          )
        ).rows[0];
        if (!delivery || !enabled()) continue;
        const parsed = pushSubscriptionSchema.parse(sub.subscription);
        if (!allowedPushEndpoint(parsed.endpoint))
          throw Error("Invalid endpoint");
        let state = "sent";
        try {
          await send(
            parsed,
            JSON.stringify({
              batchId: b.id,
              kind: done.kind,
              tag: `batch-${b.id}-${done.fingerprint}`,
            }),
          );
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 410 || status === 404) {
            state = "expired";
            await sql.query(
              "UPDATE axfluxo_video.push_subscriptions SET active=false WHERE owner_id=$1 AND id=$2",
              [owner, sub.id],
            );
          } else
            state =
              Number(delivery.attempts) >= 2 ||
              ![undefined, 408, 429, 500, 502, 503, 504].includes(status)
                ? "held"
                : "pending";
        }
        await sql.query(
          "UPDATE axfluxo_video.notification_deliveries SET state=$5,attempts=attempts+1,next_at=now()+CASE WHEN attempts=0 THEN interval '30 seconds' ELSE interval '120 seconds' END WHERE owner_id=$1 AND batch_id=$2 AND fingerprint=$3 AND subscription_id=$4",
          [owner, b.id, done.fingerprint, sub.id, state],
        );
        return;
      }
    }
  });
}
