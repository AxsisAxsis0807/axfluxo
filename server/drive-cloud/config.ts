export type DrivePolicy = {
  enabled: () => boolean;
  limitBytes: number;
  marginBytes: number;
  maxFileBytes: number;
  maxWorkBytes: number;
  minFreeBytes: number;
  directory: string;
  monthlyYen: number;
  dbLimitBytes: number;
  allow1440: boolean;
};
/** Configuration-only bound: free disk space and render peak are checked separately. */
export function maxVerifiableDriveBytes(policy: DrivePolicy): number {
  return Math.max(0, Math.min(policy.maxFileBytes, policy.maxWorkBytes - policy.marginBytes));
}

export function drivePolicy(
  env: Record<string, string | undefined>,
): DrivePolicy {
  const integer = (key: string, fallback: number) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 0)
      throw Error("Invalid Drive resource configuration");
    return n;
  };
  const monthlyYen = integer("DRIVE_CLOUD_MONTHLY_YEN", 501);
  const isolated = ["test", "development"].includes(env.NODE_ENV ?? "");
  const dbLimitBytes = integer("DRIVE_CLOUD_DB_LIMIT_BYTES", 0);
  const secureDatabase =
    isolated ||
    (env.VIDEO_DATABASE_TLS === "verify-full" &&
      Boolean(env.VIDEO_DATABASE_CA) &&
      dbLimitBytes > 0);
  const confirmed =
    env.DRIVE_CLOUD_TERMS_CONFIRMED === "true" &&
    monthlyYen <= 500 &&
    secureDatabase;
  return {
    enabled: () => env.DRIVE_CLOUD_ENABLED === "true" && confirmed,
    monthlyYen,
    dbLimitBytes,
    limitBytes: integer("DRIVE_CLOUD_LIMIT_BYTES", 10 * 1024 ** 3),
    marginBytes: integer("DRIVE_CLOUD_MARGIN_BYTES", 256 * 1024 ** 2),
    maxFileBytes: integer("DRIVE_CLOUD_MAX_FILE_BYTES", 2 * 1024 ** 3),
    maxWorkBytes: integer("VIDEO_RENDER_MAX_WORK_BYTES", 1024 ** 3),
    minFreeBytes: integer("VIDEO_RENDER_MIN_FREE_BYTES", 512 * 1024 ** 2),
    directory: env.VIDEO_RENDER_DISK ?? "/work",
    allow1440: env.DRIVE_CLOUD_1440_VERIFIED === "true",
  };
}
