// Pure transport contracts: safe to import from the static browser bundle.
import { z } from "zod";
import { fnfSnapshotSchema } from "../../src/domain/video/schema";
import { mediaVersionRefSchema } from "../../src/domain/cloud-library/schema";
export const ownerSchema = z.uuid();
export const createBatchSchema = z
  .strictObject({ snapshot: fnfSnapshotSchema })
  .superRefine((v, ctx) => {
    if (
      v.snapshot.ranges.length > 100 ||
      v.snapshot.document.clips.length > 100
    )
      ctx.addIssue({ code: "custom", message: "LIMIT_EXCEEDED" });
  });
export const jobStateSchema = z.enum([
  "queued",
  "held",
  "running",
  "failed",
  "succeeded",
  "cancel_requested",
  "cancelled",
  "interrupted",
]);
export const jobViewSchema = z.strictObject({
  id: z.uuid(),
  state: jobStateSchema,
  rangeIndex: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  retryOf: z.uuid().nullable(),
});
export const batchViewSchema = z.strictObject({
  id: z.uuid(),
  ownerId: ownerSchema,
  jobs: z.array(jobViewSchema),
  outputs: z.array(
    z.strictObject({
      id: z.uuid(),
      jobId: z.uuid(),
      reference: mediaVersionRefSchema,
    }),
  ),
});
export const developerMeSchema = z.strictObject({
  ownerId: ownerSchema,
  membership: z.literal("developer"),
});
export const mutationViewSchema = z.strictObject({
  batchId: z.uuid(),
  job: jobViewSchema,
});
export type BatchView = z.infer<typeof batchViewSchema>;
export type JobView = z.infer<typeof jobViewSchema>;
