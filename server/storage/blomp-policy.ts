import { blompMaxSize } from "../../src/domain/blomp/storage";
import type { StoragePolicy } from "./provider";

export function blompPolicy(
  env: Record<string, string | undefined>,
): StoragePolicy {
  const value = env.BLOMP_MAX_FILE_BYTES;
  const bytes =
    value && /^[1-9][0-9]*$/.test(value) && value.trim() === value
      ? Number(value)
      : NaN;
  return {
    // The application and catalog ceiling is independent of the current service plan.
    maxFileBytes: Number.isSafeInteger(bytes)
      ? Math.min(bytes, blompMaxSize)
      : null,
    multipartWrites:
      env.BLOMP_MULTIPART_ENABLED === "true" &&
      env.BLOMP_BROWSER_TRANSFER_ENABLED === "true" &&
      env.BLOMP_FREE_LIMITS_CONFIRMED === "true",
    capacityMaxAgeMs: 15 * 60 * 1000,
  };
}
