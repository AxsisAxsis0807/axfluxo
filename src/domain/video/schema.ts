import { z } from "zod";
import {
  filenameSchema,
  keySchema,
  mediaVersionRefSchema,
} from "../cloud-library/schema";
import {
  concatenateFrames,
  frameSchema,
  intervalSchema,
  microsecondsSchema,
  toFrame as toFrames,
} from "./time";

const fnfSettingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal("fnf"),
  paddingUs: microsecondsSchema,
});
export { fnfSettingsSchema };
const clipSchema = z
  .strictObject({
    id: keySchema,
    source: mediaVersionRefSchema,
    sourceDurationUs: microsecondsSchema,
    interval: intervalSchema,
    markersUs: z.array(microsecondsSchema),
  })
  .superRefine((clip, ctx) => {
    if (clip.interval.endUs > clip.sourceDurationUs)
      ctx.addIssue({ code: "custom", message: "VIDEO_INTERVAL" });
    if (
      clip.markersUs.some(
        (m, i, all) =>
          m <= clip.interval.startUs ||
          m >= clip.interval.endUs ||
          (i > 0 && m <= all[i - 1]),
      )
    )
      ctx.addIssue({ code: "custom", message: "VIDEO_MARKER" });
  });
/** The array is the authoritative clip order. No transient FNF form fields. */
export const allVersionsDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("all-versions"),
    id: keySchema,
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    clips: z.array(clipSchema).min(1),
    fnf: fnfSettingsSchema,
  })
  .superRefine((doc, ctx) => {
    if (new Set(doc.clips.map((c) => c.id)).size !== doc.clips.length)
      ctx.addIssue({ code: "custom", message: "VIDEO_CLIP_ORDER" });
    try {
      concatenateFrames(
        doc.clips.map((c) => c.interval.endUs - c.interval.startUs),
      );
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "VIDEO_INTERVAL",
      });
    }
  });

/** Submitted ranges and chart names exist only in an execution snapshot. */
export const fnfSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: keySchema,
    document: allVersionsDocumentSchema,
    ranges: z.array(intervalSchema).min(1),
    names: z.array(filenameSchema).min(1),
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.ranges.length !== snapshot.names.length)
      ctx.addIssue({ code: "custom", message: "VIDEO_NAME_COUNT" });
    const duration = snapshot.document.clips.reduce(
      (n, c) => n + BigInt(c.interval.endUs - c.interval.startUs),
      0n,
    );
    snapshot.ranges.forEach((range, i) => {
      if (
        BigInt(range.endUs) > duration ||
        (i > 0 && range.startUs < snapshot.ranges[i - 1].endUs)
      )
        ctx.addIssue({ code: "custom", message: "VIDEO_RANGE_OVERLAP" });
      if (toFrames(range.startUs) === toFrames(range.endUs))
        ctx.addIssue({ code: "custom", message: "VIDEO_ZERO_FRAMES" });
    });
    if (
      new Set(snapshot.names.map((n) => n.toLowerCase())).size !==
      snapshot.names.length
    )
      ctx.addIssue({ code: "custom", message: "VIDEO_FILENAME_COLLISION" });
  });
export const renderOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: keySchema,
  jobId: keySchema,
  reference: mediaVersionRefSchema,
  filename: filenameSchema,
  fps: z.literal(60),
  frameCount: frameSchema.refine((n) => n > 0),
});
export const renderJobSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: keySchema,
    snapshot: fnfSnapshotSchema,
    state: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    outputs: z.array(renderOutputSchema),
  })
  .superRefine((job, ctx) => {
    if (
      (job.state !== "succeeded" && job.outputs.length > 0) ||
      (job.state === "succeeded" &&
        job.outputs.length !== job.snapshot.ranges.length) ||
      job.outputs.some((o, i) => {
        const range = job.snapshot.ranges[i];
        return (
          o.jobId !== job.id ||
          o.reference.kind !== "video" ||
          o.filename !== job.snapshot.names[i] ||
          !range ||
          o.frameCount !== toFrames(range.endUs) - toFrames(range.startUs)
        );
      }) ||
      new Set(job.outputs.map((o) => o.id)).size !== job.outputs.length
    )
      ctx.addIssue({ code: "custom", message: "VIDEO_JOB_OUTPUT" });
  });
export const saveConfirmationSchema = z.discriminatedUnion("state", [
  z.strictObject({
    schemaVersion: z.literal(1),
    state: z.literal("unconfirmed"),
    outputId: keySchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    state: z.literal("confirmed"),
    outputId: keySchema,
    reference: mediaVersionRefSchema,
    receiptId: keySchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    state: z.literal("failed"),
    outputId: keySchema,
    code: z.enum(["VIDEO_STORAGE", "VIDEO_CONFLICT"]),
  }),
]);
export type AllVersionsDocument = z.infer<typeof allVersionsDocumentSchema>;
export type FnfSnapshot = z.infer<typeof fnfSnapshotSchema>;
/** Explicit allowlist projection; unsent form values never enter persisted documents. */
export function toPersistentDocument(
  input: AllVersionsDocument,
): AllVersionsDocument {
  return allVersionsDocumentSchema.parse({
    schemaVersion: input.schemaVersion,
    kind: input.kind,
    id: input.id,
    revision: input.revision,
    clips: input.clips,
    fnf: {
      schemaVersion: input.fnf.schemaVersion,
      mode: input.fnf.mode,
      paddingUs: input.fnf.paddingUs,
    },
  });
}
