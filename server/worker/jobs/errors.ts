export const renderCodes = [
  "STORAGE_TRANSIENT",
  "STORAGE_REJECTED",
  "DATABASE_TRANSIENT",
  "PROCESS_TIMEOUT",
  "WORKER_LOST",
  "DISK_FULL",
  "OUT_OF_MEMORY",
  "RESOURCE_LIMIT",
  "QUOTA_EXCEEDED",
  "DEVELOPER_REVOKED",
  "INPUT_MISSING",
  "INPUT_CORRUPT",
  "INPUT_UNSUPPORTED",
  "VALIDATION_FAILED",
  "CHECKPOINT_CORRUPT",
  "LEASE_LOST",
  "CANCELLED",
  "INTERNAL_ERROR",
] as const;
export type RenderCode = (typeof renderCodes)[number];
export class RenderError extends Error {
  constructor(readonly code: RenderCode) {
    super(code);
  }
}
export function codeOf(error: unknown): RenderCode {
  if (error instanceof RenderError) return error.code;
  const code = (error as { code?: string })?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return "DISK_FULL";
  if (code === "ENOMEM") return "OUT_OF_MEMORY";
  if (
    ["40001", "40P01", "08006", "57P01", "ECONNRESET", "ECONNREFUSED"].includes(
      code ?? "",
    )
  )
    return "DATABASE_TRANSIENT";
  return "INTERNAL_ERROR";
}
export function retryDelay(
  code: RenderCode,
  runs: number,
  random = Math.random,
): number | null {
  if (
    !["STORAGE_TRANSIENT", "DATABASE_TRANSIENT", "PROCESS_TIMEOUT"].includes(
      code,
    ) ||
    runs >= 3
  )
    return null;
  return (
    (runs === 1 ? 30 : 120) +
    Math.floor(Math.max(0, Math.min(0.999999, random())) * 11)
  );
}
export const heldCode = (code: RenderCode) =>
  [
    "STORAGE_REJECTED",
    "WORKER_LOST",
    "DISK_FULL",
    "OUT_OF_MEMORY",
    "RESOURCE_LIMIT",
    "QUOTA_EXCEEDED",
    "DEVELOPER_REVOKED",
  ].includes(code);

/** Retry only known network/provider transient failures. Unknown/403/config errors stay held. */
export function storageError(error: unknown): RenderError {
  const e = error as {
    code?: string;
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const local = codeOf(error);
  if (local === "DISK_FULL" || local === "OUT_OF_MEMORY")
    return new RenderError(local);
  const status = e?.$metadata?.httpStatusCode;
  return new RenderError(
    (status !== undefined &&
      (status === 408 || status === 429 || status >= 500)) ||
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EPIPE",
        "EAI_AGAIN",
      ].includes(e?.code ?? "") ||
      [
        "TimeoutError",
        "RequestTimeout",
        "SlowDown",
        "ServiceUnavailable",
      ].includes(e?.name ?? "")
      ? "STORAGE_TRANSIENT"
      : "STORAGE_REJECTED",
  );
}
