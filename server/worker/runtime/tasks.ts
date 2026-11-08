import { access } from "node:fs/promises";
import webpush from "web-push";
import { postgresDatabase } from "../../db/postgres";
import {
  databaseUrl,
  integerSetting,
  production,
  type Environment,
} from "../../runtime/config";
import { cloudConfiguration } from "../../storage/config";
import { UploadService } from "../../api/uploads/service";
import { verifyUpload } from "../probe/verify";
import { generatePreview, type DerivedStorage } from "../derivatives/service";
import { executeRender } from "../render/service";
import { renderConfiguration } from "../render/config";
import { claim } from "../jobs/queue";
import { deleteOne } from "../deletion/service";
import { deletionStorage } from "../deletion/storage";
import { notifyOneOwner } from "../notifications/service";
import type { RenderStorage } from "../render/objects";
import type { WorkerTask } from "./service";
export type WorkerKind =
  "probe" | "derivatives" | "render" | "deletion" | "notifications";
export async function workerTasks(env: Environment, only?: WorkerKind) {
  const tasks: WorkerTask[] = [];
  const pools: ReturnType<typeof postgresDatabase>[] = [];
  const max = integerSetting(env, "VIDEO_WORKER_POOL_MAX", 1, 1, 3);
  const connect = (
    role: Parameters<typeof postgresDatabase>[1],
    key = "VIDEO_DATABASE_URL",
  ) => {
    const db = postgresDatabase(
      {
        connectionString: databaseUrl(env, key),
        max,
        ssl: production(env) ? { rejectUnauthorized: true } : undefined,
      },
      role,
    );
    pools.push(db);
    return db;
  };
  const selected = (kind: WorkerKind) => !only || only === kind;
  const flag = (key: string) => () => env[key] === "true";
  try {
    // Disabled unified runtime is an inert process: no DB pools or cloud credentials required.
    if (!only && env.VIDEO_WORKER_ENABLED !== "true")
      return { tasks, close: async () => {} };
    const cloud = cloudConfiguration(env);
    const probeEnabled = only === "probe" || env.VIDEO_PROBE_ENABLED === "true";
    const previewEnabled = env.CLOUD_PREVIEW_ENABLED === "true";
    if (
      cloud.storage &&
      ((selected("probe") && probeEnabled) ||
        (selected("derivatives") && previewEnabled))
    ) {
      const db = connect("axfluxo_video_probe");
      const service = new UploadService(db, cloud.storage, () => false);
      if (selected("probe") && probeEnabled) {
        const enabled = () =>
          only === "probe" || env.VIDEO_PROBE_ENABLED === "true";
        tasks.push({
          name: "upload-safety",
          enabled,
          async run(signal) {
            const row = (
              await db.transaction((sql) =>
                sql.query(
                  "SELECT owner_id,id,state FROM axfluxo_video.upload_sessions WHERE (state='completing' OR (state IN ('creating','uploading','aborting') AND expires_at<now())) AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 1",
                ),
              )
            ).rows[0];
            signal.throwIfAborted();
            if (row) {
              if (row.state === "completing")
                await service.complete(String(row.owner_id), String(row.id));
              else
                await service.abort(String(row.owner_id), String(row.id), true);
            }
          },
        });
        tasks.push({
          name: "verify",
          enabled,
          async run(signal) {
            const row = (
              await db.transaction((sql) =>
                sql.query(
                  "SELECT owner_id,id FROM axfluxo_video.upload_sessions WHERE state='verifying' AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 1",
                ),
              )
            ).rows[0];
            signal.throwIfAborted();
            if (row)
              await verifyUpload(
                service,
                String(row.owner_id),
                String(row.id),
                signal,
              );
          },
        });
      }
      if (selected("derivatives") && previewEnabled && cloud.storage.putDerived)
        tasks.push({
          name: "preview",
          enabled: cloud.previewEnabled,
          async run(signal) {
            const row = (
              await db.transaction((sql) =>
                sql.query(
                  "SELECT owner_id,version_id FROM axfluxo_video.media_preview_jobs WHERE state IN ('queued','generating') AND (lease_until IS NULL OR lease_until<now()) ORDER BY id LIMIT 1",
                ),
              )
            ).rows[0];
            signal.throwIfAborted();
            if (row)
              await generatePreview(
                db,
                cloud.storage as DerivedStorage,
                String(row.owner_id),
                String(row.version_id),
                signal,
              );
          },
        });
    }
    if (
      selected("render") &&
      env.VIDEO_RENDER_ENABLED === "true" &&
      cloud.storage?.putRender
    ) {
      const config = renderConfiguration(env);
      await access(config.directory);
      const db = connect("axfluxo_video_render");
      const task: WorkerTask = {
        name: "render",
        enabled: config.enabled,
        async run(signal) {
          signal.throwIfAborted();
          const c = await claim(db);
          if (c)
            await executeRender(
              db,
              cloud.storage as RenderStorage,
              c,
              config,
              signal,
            );
        },
      };
      const index = tasks.findIndex((t) => t.name === "preview");
      tasks.splice(index < 0 ? tasks.length : index, 0, task);
    }
    if (selected("deletion") && env.VIDEO_DELETE_WORKER_ENABLED === "true") {
      const storage = deletionStorage(env);
      const db = connect("axfluxo_video_delete", "VIDEO_DELETE_DATABASE_URL");
      tasks.push({
        name: "deletion",
        enabled: flag("VIDEO_DELETE_WORKER_ENABLED"),
        async run(signal) {
          await deleteOne(
            db,
            storage,
            () => !signal.aborted && env.VIDEO_DELETE_WORKER_ENABLED === "true",
            signal,
          );
        },
      });
    }
    if (selected("notifications") && env.VIDEO_PUSH_ENABLED === "true") {
      if (
        !env.VIDEO_VAPID_SUBJECT ||
        !env.VIDEO_VAPID_PUBLIC_KEY ||
        !env.VIDEO_VAPID_PRIVATE_KEY
      )
        throw Error("Unconfigured notification credentials");
      webpush.setVapidDetails(
        env.VIDEO_VAPID_SUBJECT,
        env.VIDEO_VAPID_PUBLIC_KEY,
        env.VIDEO_VAPID_PRIVATE_KEY,
      );
      const db = connect("axfluxo_video_notify", "VIDEO_NOTIFY_DATABASE_URL");
      let cursor = "";
      tasks.push({
        name: "notifications",
        enabled: flag("VIDEO_PUSH_ENABLED"),
        async run(signal) {
          let rows = (
            await db.transaction((sql) =>
              sql.query(
                "SELECT DISTINCT owner_id FROM axfluxo_video.push_subscriptions WHERE active AND owner_id::text>$1 ORDER BY owner_id LIMIT 1",
                [cursor],
              ),
            )
          ).rows;
          if (!rows.length) {
            cursor = "";
            rows = (
              await db.transaction((sql) =>
                sql.query(
                  "SELECT DISTINCT owner_id FROM axfluxo_video.push_subscriptions WHERE active ORDER BY owner_id LIMIT 1",
                ),
              )
            ).rows;
          }
          signal.throwIfAborted();
          if (rows[0]) {
            cursor = String(rows[0].owner_id);
            await notifyOneOwner(
              db,
              cursor,
              async (sub, payload) => {
                signal.throwIfAborted();
                await webpush.sendNotification(sub, payload, {
                  TTL: 86400,
                  timeout: 3000,
                });
              },
              () => !signal.aborted && env.VIDEO_PUSH_ENABLED === "true",
            );
          }
        },
      });
    }
    return {
      tasks,
      close: async () => {
        await Promise.all(pools.map((db) => db.close()));
      },
    };
  } catch {
    await Promise.all(pools.map((db) => db.close()));
    throw Error("Worker configuration failed");
  }
}
