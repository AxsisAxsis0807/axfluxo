import { z } from "zod";
import { microsecondsSchema } from "../video/time";
import { hashSchema } from "../cloud-library/schema";

/**
 * Minimal cloud export contract. Shared by the browser client and the Node API.
 * No secret, filesystem path, storage key or renderer/DB value crosses this module.
 */
export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_RENDERER = "axfluxo-all-versions-v5.1";
export const EXPORT_FONT_HASH =
  "62b6cb49b7b087b341f0307ea3bc871a9690d8947691206ab025d149b8f6ed6f";

/** Fixed production profile. Diagnostics may lower it only through an explicit test build. */
export const EXPORT_PROFILE = {
  width: 1920,
  height: 1080,
  fps: 60 as const,
  videoCodec: "h264" as const,
  audioCodec: "aac" as const,
  sampleRate: 48000,
  channels: 2,
};

export const exportLimits = {
  maxUploadBytes: 64 * 1024 ** 2,
  maxImageBytes: 8 * 1024 ** 2,
  maxClips: 20,
  maxNames: 100,
  maxMarkersPerClip: 99,
  maxFrames: 900,
  maxOutputBytes: 256 * 1024 ** 2,
  chunkBytes: 1024 * 1024,
  maxBodyBytes: 96 * 1024,
  maxNameLength: 200,
  uploadIdleMs: 30 * 60 * 1000,
} as const;

export const exportCodes = [
  "EXPORT_DISABLED",
  "EXPORT_NOT_FOUND",
  "EXPORT_BUSY",
  "EXPORT_CONFLICT",
  "EXPORT_LIMIT_EXCEEDED",
  "EXPORT_HASH_MISMATCH",
  "EXPORT_INPUT_UNSUPPORTED",
  "EXPORT_INPUT_CORRUPT",
  "EXPORT_INPUT_MISSING",
  "EXPORT_LEASE_LOST",
  "EXPORT_CANCELLED",
  "EXPORT_WORKER_LOST",
  "EXPORT_TIMEOUT",
  "EXPORT_DISK_FULL",
  "EXPORT_OUT_OF_MEMORY",
  "EXPORT_OUTPUT_INVALID",
  "EXPORT_STORAGE_UNAVAILABLE",
  "EXPORT_BLOB_INCOMPLETE",
] as const;
export type ExportCode = (typeof exportCodes)[number];

export const exportErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.enum(exportCodes) }),
});

export const exportBlobKindSchema = z.enum(["video", "image"]);
export type ExportBlobKind = z.infer<typeof exportBlobKindSchema>;

export const exportBlobViewSchema = z.strictObject({
  id: z.uuid(),
  kind: exportBlobKindSchema,
  size: z.number().int().positive(),
  sha256: hashSchema,
});
export type ExportBlobView = z.infer<typeof exportBlobViewSchema>;

export const exportClipSchema = z
  .strictObject({
    blobId: z.uuid(),
    startUs: microsecondsSchema,
    endUs: microsecondsSchema,
    markersUs: z.array(microsecondsSchema).max(exportLimits.maxMarkersPerClip),
  })
  .superRefine((clip, ctx) => {
    if (clip.endUs <= clip.startUs)
      ctx.addIssue({ code: "custom", message: "VIDEO_INTERVAL" });
    if (
      clip.markersUs.some(
        (m, i, all) =>
          m <= clip.startUs ||
          m >= clip.endUs ||
          (i > 0 && m <= all[i - 1]),
      )
    )
      ctx.addIssue({ code: "custom", message: "VIDEO_MARKER" });
  });

export const exportDesignSchema = z.strictObject({
  height: z.literal(EXPORT_PROFILE.height),
  fadeInFrames: z.number().int().min(0).max(120),
  fadeOutFrames: z.number().int().min(0).max(120),
});

export const exportJobRequestSchema = z.strictObject({
  schemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
  clips: z.array(exportClipSchema).min(1).max(exportLimits.maxClips),
  names: z
    .array(z.string().min(1).max(exportLimits.maxNameLength))
    .min(1)
    .max(exportLimits.maxNames),
  coverBlobId: z.uuid(),
  design: exportDesignSchema,
});
export type ExportJobRequest = z.infer<typeof exportJobRequestSchema>;

export const exportStates = [
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type ExportState = (typeof exportStates)[number];

export const exportJobViewSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(exportStates),
  errorCode: z.enum(exportCodes).nullable(),
  completedFrames: z.number().int().nonnegative(),
  totalFrames: z.number().int().nonnegative(),
  output: z
    .strictObject({
      filename: z.string().min(1).max(200),
      size: z.number().int().positive(),
      sha256: hashSchema,
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      fps: z.literal(EXPORT_PROFILE.fps),
      frames: z.number().int().positive(),
      durationUs: z.number().int().positive(),
    })
    .nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type ExportJobView = z.infer<typeof exportJobViewSchema>;

export const exportSessionViewSchema = z.strictObject({
  enabled: z.boolean(),
  maxUploadBytes: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  maxClips: z.number().int().positive(),
  maxFrames: z.number().int().positive(),
  maxOwnerBytes: z.number().int().positive(),
  retentionHours: z.number().int().positive(),
  profile: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
  }),
});
export type ExportSessionView = z.infer<typeof exportSessionViewSchema>;

export const exportOutputName = "AxFluxo Cloud Export.mp4";

/** A relative path; the client resolves it against the validated API origin. */
export const exportDownloadTicketSchema = z.strictObject({
  url: z.string().regex(/^\/v1\/cloud-export\/downloads\/[A-Za-z0-9_-]{43}$/),
  expiresAt: z.string(),
});
export type ExportDownloadTicket = z.infer<typeof exportDownloadTicketSchema>;

export const exportDeleteViewSchema = z.strictObject({
  deleted: z.literal(true),
});
