/** Server-only configuration. Errors name the setting, never its secret value. */
export class ConfigurationError extends Error {}
export type Environment = Record<string, string | undefined>;
export function integerSetting(
  env: Environment,
  key: string,
  fallback: number,
  min = 1,
  max = 3600000,
) {
  const raw = env[key];
  if (raw !== undefined && !/^\d+$/.test(raw))
    throw new ConfigurationError(`Invalid ${key} configuration`);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new ConfigurationError(`Invalid ${key} configuration`);
  return value;
}
export function databaseUrl(
  env: Environment,
  dedicated = "VIDEO_DATABASE_URL",
) {
  const primary = env[dedicated],
    fallback = env.DATABASE_URL;
  function parse(value: string) {
    try {
      const url = new URL(value);
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        !url.hostname ||
        !url.username ||
        !url.pathname.slice(1) ||
        url.search ||
        url.hash
      )
        throw new ConfigurationError();
      url.protocol = "postgresql:";
      if (url.port === "5432") url.port = "";
      return url;
    } catch {
      throw new ConfigurationError("Invalid database connection configuration");
    }
  }
  const a = primary === undefined ? undefined : parse(primary);
  const b = fallback === undefined ? undefined : parse(fallback);
  if (a && b && a.href !== b.href)
    throw new ConfigurationError(
      "Conflicting database connection configuration",
    );
  const value = primary ?? fallback;
  if (!value)
    throw new ConfigurationError(
      "Missing server authentication/database configuration",
    );
  return value;
}
export function production(env: Environment) {
  return !["test", "development"].includes(env.NODE_ENV ?? "");
}
