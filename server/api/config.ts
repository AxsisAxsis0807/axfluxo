import {
  databaseUrl as resolveDatabaseUrl,
  integerSetting,
} from "../runtime/config";
import { databaseTls } from "../db/tls";
export function serverConfig(env: Record<string, string | undefined>) {
  const issuer = env.VIDEO_JWT_ISSUER;
  const audience = env.VIDEO_JWT_AUDIENCE;
  const databaseUrl = resolveDatabaseUrl(env);
  if (!issuer || !audience)
    throw new Error("Missing server authentication/database configuration");
  const port = integerSetting(
    { ...env, API_PORT: env.PORT ?? env.VIDEO_API_PORT },
    "API_PORT",
    3100,
    1,
    65535,
  );
  const host = env.VIDEO_API_HOST ?? "0.0.0.0";
  if (!["0.0.0.0", "127.0.0.1", "::", "::1"].includes(host))
    throw Error("Invalid API host configuration");
  const rawPrice = env.VIDEO_UNITS_PER_FRAME;
  const unitsPerFrame = rawPrice === undefined ? undefined : Number(rawPrice);
  if (
    rawPrice !== undefined &&
    (!Number.isSafeInteger(unitsPerFrame) ||
      unitsPerFrame! < 1 ||
      unitsPerFrame! > 1_000_000)
  )
    throw new Error("Invalid budget unit configuration");
  return {
    issuer,
    audience,
    databaseUrl,
    tls: databaseTls(env),
    port,
    host,
    poolMax: integerSetting(env, "VIDEO_API_POOL_MAX", 2, 1, 10),
    shutdownMs: integerSetting(env, "VIDEO_SHUTDOWN_MS", 20000, 3000, 120000),
    unitsPerFrame,
    production: env.NODE_ENV !== "development" && env.NODE_ENV !== "test",
    admissionEnabled: () => env.VIDEO_ACCEPTING === "true",
    allowedOrigins: (env.VIDEO_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  };
}
