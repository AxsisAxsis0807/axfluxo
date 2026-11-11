import { isAbsolute } from "node:path";
import { databaseUrl, integerSetting } from "../runtime/config";
import { exportLimits } from "../../src/domain/cloud-export/schema";

/**
 * Server-only minimal cloud export configuration. Errors name a setting, never a value.
 * The database is the existing server database; no new credential is introduced.
 */
export function exportApiConfiguration(
  env: Record<string, string | undefined>,
) {
  return {
    enabled: () => env.EXPORT_ENABLED === "true",
    maxUploadBytes: integerSetting(
      env,
      "EXPORT_MAX_UPLOAD_BYTES",
      exportLimits.maxUploadBytes,
      1024 * 1024,
      64 * 1024 * 1024,
    ),
    maxImageBytes: integerSetting(
      env,
      "EXPORT_MAX_IMAGE_BYTES",
      exportLimits.maxImageBytes,
      64 * 1024,
      512 * 1024 * 1024,
    ),
    maxClips: integerSetting(
      env,
      "EXPORT_MAX_CLIPS",
      exportLimits.maxClips,
      1,
      100,
    ),
    maxFrames: integerSetting(
      env,
      "EXPORT_MAX_FRAMES",
      exportLimits.maxFrames,
      1,
      18000,
    ),
  };
}
export type ExportApiConfig = ReturnType<typeof exportApiConfiguration>;

export function exportWorkerConfiguration(
  env: Record<string, string | undefined>,
) {
  const workDirectory = env.EXPORT_WORK_DIR ?? "/tmp/axfluxo-export";
  if (!isAbsolute(workDirectory))
    throw new Error("Invalid EXPORT_WORK_DIR configuration");
  return {
    workDirectory,
    databaseUrl: databaseUrl(env),
    production: !["test", "development"].includes(env.NODE_ENV ?? ""),
    maxWorkBytes: integerSetting(
      env,
      "EXPORT_MAX_WORK_BYTES",
      2 * 1024 ** 3,
      256 * 1024 ** 2,
      64 * 1024 ** 3,
    ),
    minFreeBytes: integerSetting(
      env,
      "EXPORT_MIN_FREE_BYTES",
      512 * 1024 ** 2,
      64 * 1024 ** 2,
      64 * 1024 ** 3,
    ),
    maxUploadBytes: integerSetting(
      env,
      "EXPORT_MAX_UPLOAD_BYTES",
      exportLimits.maxUploadBytes,
      1024 * 1024,
      64 * 1024 * 1024,
    ),
    maxFrames: integerSetting(
      env,
      "EXPORT_MAX_FRAMES",
      exportLimits.maxFrames,
      1,
      18000,
    ),
    sessionTimeoutMs: integerSetting(
      env,
      "EXPORT_SESSION_TIMEOUT_MS",
      20 * 60 * 1000,
      60000,
      3600000,
    ),
    pollMs: integerSetting(env, "EXPORT_WORKER_POLL_MS", 1000, 100, 60000),
    segmentFrames: integerSetting(
      env,
      "EXPORT_SEGMENT_FRAMES",
      1800,
      60,
      18000,
    ),
  };
}
export type ExportWorkerConfig = ReturnType<typeof exportWorkerConfiguration>;
