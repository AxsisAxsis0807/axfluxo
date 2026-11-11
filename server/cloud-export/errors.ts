import { codeOf, RenderError, type RenderCode } from "../worker/jobs/errors";
import type { ExportCode } from "../../src/domain/cloud-export/schema";

const mapping: Record<RenderCode, ExportCode> = {
  STORAGE_TRANSIENT: "EXPORT_STORAGE_UNAVAILABLE",
  STORAGE_REJECTED: "EXPORT_STORAGE_UNAVAILABLE",
  DATABASE_TRANSIENT: "EXPORT_STORAGE_UNAVAILABLE",
  PROCESS_TIMEOUT: "EXPORT_TIMEOUT",
  WORKER_LOST: "EXPORT_WORKER_LOST",
  DISK_FULL: "EXPORT_DISK_FULL",
  OUT_OF_MEMORY: "EXPORT_OUT_OF_MEMORY",
  RESOURCE_LIMIT: "EXPORT_LIMIT_EXCEEDED",
  QUOTA_EXCEEDED: "EXPORT_LIMIT_EXCEEDED",
  DEVELOPER_REVOKED: "EXPORT_DISABLED",
  FONT_UNAVAILABLE: "EXPORT_INPUT_UNSUPPORTED",
  FONT_GLYPH_UNSUPPORTED: "EXPORT_INPUT_UNSUPPORTED",
  FNF_FONT_UNAVAILABLE: "EXPORT_INPUT_UNSUPPORTED",
  FNF_INVALID_CROP: "EXPORT_INPUT_UNSUPPORTED",
  INPUT_MISSING: "EXPORT_INPUT_MISSING",
  INPUT_CORRUPT: "EXPORT_INPUT_CORRUPT",
  INPUT_UNSUPPORTED: "EXPORT_INPUT_UNSUPPORTED",
  VALIDATION_FAILED: "EXPORT_OUTPUT_INVALID",
  CHECKPOINT_CORRUPT: "EXPORT_OUTPUT_INVALID",
  LEASE_LOST: "EXPORT_LEASE_LOST",
  CANCELLED: "EXPORT_CANCELLED",
  INTERNAL_ERROR: "EXPORT_OUTPUT_INVALID",
};

export class ExportError extends Error {
  constructor(readonly code: ExportCode) {
    super(code);
  }
}
export function exportCodeOf(error: unknown): ExportCode {
  if (error instanceof ExportError) return error.code;
  if (error instanceof RenderError) return mapping[error.code];
  const code = (error as { code?: string })?.code;
  if (
    code === "ENOSPC" ||
    code === "EDQUOT" ||
    code === "EXPORT_DISK_FULL"
  )
    return "EXPORT_DISK_FULL";
  if (code === "ENOMEM") return "EXPORT_OUT_OF_MEMORY";
  if (
    ["40001", "40P01", "08006", "57P01", "ECONNRESET", "ECONNREFUSED"].includes(
      code ?? "",
    )
  )
    return "EXPORT_STORAGE_UNAVAILABLE";
  const message = error instanceof Error ? error.message : "";
  if (/No space left|Disk quota/i.test(message)) return "EXPORT_DISK_FULL";
  return "EXPORT_OUTPUT_INVALID";
}
/** Only these codes are retried by the durable queue; everything else is terminal. */
export const retryable: readonly ExportCode[] = [
  "EXPORT_STORAGE_UNAVAILABLE",
  "EXPORT_TIMEOUT",
  "EXPORT_WORKER_LOST",
];
export function toRenderError(error: unknown) {
  if (error instanceof RenderError) return error;
  const code = exportCodeOf(error);
  const render: RenderCode =
    code === "EXPORT_DISK_FULL"
      ? "DISK_FULL"
      : code === "EXPORT_OUT_OF_MEMORY"
        ? "OUT_OF_MEMORY"
        : code === "EXPORT_TIMEOUT"
          ? "PROCESS_TIMEOUT"
          : code === "EXPORT_CANCELLED"
            ? "CANCELLED"
            : code === "EXPORT_INPUT_CORRUPT"
              ? "INPUT_CORRUPT"
              : code === "EXPORT_INPUT_UNSUPPORTED"
                ? "INPUT_UNSUPPORTED"
                : code === "EXPORT_LEASE_LOST"
                  ? "LEASE_LOST"
                  : "INTERNAL_ERROR";
  return new RenderError(render);
}
export { codeOf };
