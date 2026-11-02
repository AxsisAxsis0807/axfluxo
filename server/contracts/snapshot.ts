import {
  fnfSnapshotSchema,
  type FnfSnapshot,
} from "../../src/domain/video/schema";
import {
  fnfShowcaseSnapshotSchema,
  isFnfShowcase,
} from "../../src/domain/video/fnf-showcase";
/** V0/V1 snapshot stays strict. Only the explicit V6 discriminator enables overlaps. */
export function executionSnapshot(value: unknown): FnfSnapshot {
  return isFnfShowcase(value)
    ? fnfShowcaseSnapshotSchema.parse(value)
    : fnfSnapshotSchema.parse(value);
}
export function safeExecutionSnapshot(value: unknown) {
  try {
    return { success: true as const, data: executionSnapshot(value) };
  } catch {
    return { success: false as const };
  }
}
