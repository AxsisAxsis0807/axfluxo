import { z } from "zod";
import { hashSchema } from "../cloud-library/schema";
export const previewCodeSchema = z.enum([
  "PROXY_NOT_READY",
  "SOURCE_MISSING",
  "PLAYBACK_FAILED",
  "AUTH_EXPIRED",
  "INVALID_INTERVAL",
  "PREVIEW_FAILED",
]);
const url = z.url().refine((v) => new URL(v).protocol === "https:");
export const ptsMappingSchema = z.strictObject({
  sourceFirstPtsUs: z.number().int(),
  proxyFirstPtsUs: z.number().int().nonnegative(),
  sourceTimeBase: z.string(),
  proxyTimeBase: z.string(),
});
export const previewInfoSchema = z.strictObject({
  versionId: z.uuid(),
  assetId: z.uuid(),
  hash: hashSchema,
  durationUs: z.number().int().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  mapping: ptsMappingSchema,
  rate: z.strictObject({
    numerator: z.number().int().positive(),
    denominator: z.number().int().positive(),
  }),
  rotationDegrees: z.number(),
  proxy: url,
  thumbnail: url,
  waveform: url,
  expiresAt: z.number(),
});
export const waveformSchema = z.strictObject({
  schemaVersion: z.literal(1),
  versionId: z.uuid(),
  hash: hashSchema,
  originUs: z.number().int(),
  sampleRate: z.literal(8000),
  levels: z
    .array(
      z.strictObject({
        stepUs: z.number().positive(),
        peaks: z.array(z.number().min(-1).max(1)).max(200000),
      }),
    )
    .max(3),
});
export type PreviewInfo = z.infer<typeof previewInfoSchema>;
export type Waveform = z.infer<typeof waveformSchema>;
