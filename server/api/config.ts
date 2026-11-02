export function serverConfig(env: Record<string, string | undefined>) {
  const issuer = env.VIDEO_JWT_ISSUER;
  const audience = env.VIDEO_JWT_AUDIENCE;
  const databaseUrl = env.VIDEO_DATABASE_URL;
  if (!issuer || !audience || !databaseUrl)
    throw new Error("Missing server authentication/database configuration");
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Invalid database connection configuration");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Invalid database connection configuration");
  const port = Number(env.VIDEO_API_PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid API port");
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
    port,
    unitsPerFrame,
    production: env.NODE_ENV !== "development" && env.NODE_ENV !== "test",
    admissionEnabled: () => env.VIDEO_ACCEPTING === "true",
    allowedOrigins: (env.VIDEO_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  };
}
