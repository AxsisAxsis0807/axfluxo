import { isAbsolute } from "node:path";
import { databaseUrl } from "../../runtime/config";
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
  const database = databaseUrl(env);
  return {
    directory,
    maxWorkBytes,
    minFreeBytes,
    databaseUrl: database,
    production: !["test", "development"].includes(env.NODE_ENV ?? ""),
    enabled: () => env.VIDEO_RENDER_ENABLED === "true",
  };
}
