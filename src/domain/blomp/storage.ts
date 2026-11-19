import { mimeSchema } from "../cloud-library/media";
import { z } from "zod";

export const blompPartSize = 8 * 1024 ** 2;
export const blompMaxSize = 5 * 1024 ** 3;
export const blompRole = z.enum(["originals", "outputs"]);
export const blompStart = z.strictObject({
  role: blompRole,
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[^\x00-\x1f\x7f/\\]+$/),
  mime: mimeSchema,
  size: z.number().int().positive().max(blompMaxSize),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  projectId: z.uuid().nullable(),
  jobId: z.uuid().nullable(),
});
export const blompFile = blompStart.extend({
  id: z.uuid(),
  provider: z.literal("blomp"),
  status: z.enum([
    "queued",
    "creating",
    "uploading",
    "interrupted",
    "completing",
    "verifying",
    "ready",
    "failed",
    "aborting",
    "cancelled",
  ]),
  version: z.literal(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
});
export const blompParts = z.array(
  z.strictObject({
    number: z.number().int().positive(),
    size: z.number().int().positive(),
  }),
);
export const blompOverview = z.strictObject({
  state: z.enum(["disabled", "held", "available"]),
  capacity: z.number().nullable(),
  measuredUsed: z.number().nullable(),
  estimatedUsed: z.number().nullable(),
  available: z.number().nullable(),
  reserved: z.number(),
  verifiedAt: z.string().nullable(),
});
export const blompErrorCodes = [
  "BLOMP_WRITES_HELD",
  "BLOMP_STATE_CONFLICT",
  "BLOMP_OPERATION_UNCONFIRMED",
] as const;
export const blompAccess = z.strictObject({
  url: z.url(),
  expiresAt: z.number(),
});
export type BlompFile = z.infer<typeof blompFile>;
export type BlompStart = z.infer<typeof blompStart>;
export function partLength(size: number, number: number) {
  return Math.max(
    0,
    Math.min(blompPartSize, size - (number - 1) * blompPartSize),
  );
}
