import { z } from "zod";

export const microsecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export const frameSchema = microsecondsSchema;
export const intervalSchema = z
  .strictObject({ startUs: microsecondsSchema, endUs: microsecondsSchema })
  .refine((v) => v.endUs > v.startUs, { message: "VIDEO_INTERVAL" });

/** Nearest frame; exact half rounds up. BigInt avoids intermediate precision loss. */
export function toFrame(us: number): number {
  microsecondsSchema.parse(us);
  return Number((BigInt(us) * 60n + 500_000n) / 1_000_000n);
}

/** Round cumulative boundaries, never each clip independently. */
export function concatenateFrames(durationsUs: readonly number[]) {
  let total = 0n;
  let previous = 0;
  return durationsUs.map((duration) => {
    microsecondsSchema.refine((v) => v > 0).parse(duration);
    total += BigInt(duration);
    if (total > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("VIDEO_TIME_OVERFLOW");
    const endFrame = toFrame(Number(total));
    if (endFrame === previous) throw new Error("VIDEO_ZERO_FRAMES");
    const result = { startFrame: previous, endFrame };
    previous = endFrame;
    return result;
  });
}
