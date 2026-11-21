import { storageRoles } from "../storage/destinations";
import { mimeSchema } from "../cloud-library/media";
import { z } from "zod";

export const blompPartSize = 8 * 1024 ** 2;
export const blompMaxSize = 5 * 1024 ** 3;
export const blompRole = z.enum(storageRoles);
const fileMetadata = z.strictObject({
  role: blompRole,
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\x00-\x1f\x7f/\\]+$/)
    .refine((name) => name.trim().length > 0),
  mime: mimeSchema.or(z.enum(["application/json", "application/octet-stream"])),
  size: z.number().int().positive().max(blompMaxSize),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  projectId: z.uuid().nullable(),
  projectName: z.string().trim().min(1).max(120).optional(),
  jobId: z.uuid().nullable(),
});
function allowedRoleMime(value: z.infer<typeof fileMetadata>) {
  return (
    mimeSchema.safeParse(value.mime).success || value.role === "checkpoints"
  );
}
export const blompStart = fileMetadata.refine(allowedRoleMime);
export const blompFile = fileMetadata
  .extend({
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
  })
  .refine(allowedRoleMime);
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
  capabilities: z
    .strictObject({
      multipartWrites: z.boolean(),
      maxFileBytes: z.number().int().positive().nullable(),
    })
    .optional(),
});
export const blompErrorCodes = [
  "BLOMP_WRITES_HELD",
  "BLOMP_FILE_LIMIT",
  "BLOMP_AUTH_EXPIRED",
  "BLOMP_AUTH_FAILED",
  "BLOMP_ACCOUNT_UNAVAILABLE",
  "BLOMP_CAPACITY_HELD",
  "BLOMP_RATE_LIMITED",
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
