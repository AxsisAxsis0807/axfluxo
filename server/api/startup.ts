import { ConfigurationError } from "../runtime/config";

/** Ordered startup phases, so a failure names the step without any value. */
export type StartupStage =
  | "config"
  | "storage"
  | "jwt"
  | "database"
  | "export"
  | "router"
  | "http"
  | "listen";

/**
 * Messages that only name a setting. Everything else is dropped: a driver or
 * platform error can carry a host, a path or a connection string.
 */
const SAFE_MESSAGES = new Set([
  "Missing VIDEO_JWT_ISSUER/VIDEO_JWT_AUDIENCE configuration",
  "Missing database connection configuration",
  "Invalid database connection configuration",
  "Conflicting database connection configuration",
  "Invalid JWT issuer configuration",
  "Invalid CORS origin configuration",
  "Explicit CORS origins required",
  "Invalid API host configuration",
  "Invalid budget unit configuration",
  "Incomplete server storage configuration",
  "Invalid role",
  "Invalid database pool maximum",
]);

export class StartupError extends Error {
  constructor(
    readonly stage: StartupStage,
    readonly reason: unknown,
  ) {
    super("API startup failed");
    this.name = "StartupError";
  }
}

/** Node system codes such as EADDRINUSE are safe: they carry no address. */
function systemCode(error: unknown) {
  if (typeof error !== "object" || !error || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" && /^E[A-Z]{3,}$/.test(code) ? code : null;
}

export function safeStartupDetail(error: unknown): string | null {
  if (error instanceof ConfigurationError) return error.message;
  if (error instanceof Error && SAFE_MESSAGES.has(error.message))
    return error.message;
  return systemCode(error);
}

/** One line: stage plus a whitelisted reason. Never a value, URL or token. */
export function startupFailureLine(error: unknown): string {
  const stage = error instanceof StartupError ? ` at ${error.stage}` : "";
  const detail = safeStartupDetail(
    error instanceof StartupError ? error.reason : error,
  );
  return `API startup failed${stage}${detail ? `: ${detail}` : ""}`;
}
