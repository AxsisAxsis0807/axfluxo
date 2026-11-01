import { z } from "zod";
import { hashSchema } from "./schema";
export const MiB = 1024 * 1024;
export const PROVIDER_LIMITS = {
  initialPartSize: 16 * MiB,
  minPartSize: 5 * MiB,
  maxPartSize: 5 * 1024 * MiB,
  maxParts: 10000,
  maxObjectSize: 5 * 1024 * 1024 * MiB,
} as const;
export function multipartLayout(
  size: number,
  maxParts: number = PROVIDER_LIMITS.maxParts,
) {
  z.number().int().positive().max(PROVIDER_LIMITS.maxObjectSize).parse(size);
  z.number().int().min(1).max(PROVIDER_LIMITS.maxParts).parse(maxParts);
  const partSize = Math.max(
    PROVIDER_LIMITS.initialPartSize,
    Math.ceil(size / maxParts / MiB) * MiB,
  );
  if (partSize > PROVIDER_LIMITS.maxPartSize)
    throw new Error("UPLOAD_TOO_LARGE");
  return { partSize, partCount: Math.ceil(size / partSize) };
}
export const displayNameSchema = z
  .string()
  .min(1)
  .max(500)
  .transform(
    (s) =>
      s
        .normalize("NFC")
        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
        .trim()
        .slice(0, 200) || "unnamed",
  );
export const mimeSchema = z.enum([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "image/png",
  "image/jpeg",
  "image/webp",
]);
export const cloudErrorCodes = [
  "FOLDER_CYCLE",
  "SYSTEM_FOLDER",
  "UPLOAD_INTERRUPTED",
  "QUOTA_EXCEEDED",
  "QUOTA_UNCONFIGURED",
  "UPLOADS_DISABLED",
  "UPLOAD_SIGNATURE_EXPIRED",
  "UPLOAD_FILE_MISMATCH",
  "UPLOAD_PART_MISMATCH",
  "UPLOAD_BUSY",
  "UPLOAD_EXPIRED",
  "UPLOAD_ABORTED",
  "UPLOAD_ALREADY_COMPLETED",
  "MIME_MISMATCH",
  "CORRUPT_MEDIA",
  "CODEC_UNSUPPORTED",
  "HASH_MISMATCH",
  "SIZE_MISMATCH",
  "STORAGE_UNAVAILABLE",
] as const;
export type CloudErrorCode = (typeof cloudErrorCodes)[number];
export const folderSchema = z.strictObject({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  name: z.string(),
  systemKey: z.string().nullable(),
});
export const folderPageSchema = z.strictObject({
  items: z.array(folderSchema),
  nextCursor: z.uuid().nullable(),
});
export const assetSchema = z.strictObject({
  id: z.uuid(),
  folderId: z.uuid().nullable(),
  name: z.string(),
  deleted: z.boolean(),
  versionId: z.uuid(),
  hash: hashSchema,
  kind: z.enum(["video", "audio", "image"]),
  mime: mimeSchema,
  size: z.number().int().positive(),
});
export const assetPageSchema = z.strictObject({
  items: z.array(assetSchema),
  nextCursor: z.uuid().nullable(),
});
export const cloudReferenceSchema = z.strictObject({
  scope: z.literal("cloud-library"),
  assetId: z.uuid(),
  versionId: z.uuid(),
  hash: hashSchema,
  kind: z.enum(["video", "audio", "image"]),
});
export const uploadStartSchema = z.strictObject({
  folderId: z.uuid().nullable(),
  name: displayNameSchema,
  size: z.number().int().positive().max(PROVIDER_LIMITS.maxObjectSize),
  mime: mimeSchema,
  sha256: hashSchema,
});
export const partPlanSchema = z.strictObject({
  number: z.number().int().min(1).max(PROVIDER_LIMITS.maxParts),
  size: z.number().int().positive().max(PROVIDER_LIMITS.maxPartSize),
  sha256: hashSchema,
  md5: z.string().regex(/^[a-f0-9]{32}$/),
});
export const uploadStateSchema = z.enum([
  "creating",
  "uploading",
  "completing",
  "verifying",
  "ready",
  "failed",
  "aborting",
  "aborted",
  "expired",
]);
export const uploadViewSchema = z.strictObject({
  id: z.uuid(),
  ownerId: z.uuid(),
  name: z.string(),
  size: z.number(),
  sha256: hashSchema,
  partSize: z.number(),
  partCount: z.number(),
  state: uploadStateSchema,
  parts: z.array(partPlanSchema.extend({ etag: z.string().nullable() })),
  error: z.string().nullable(),
  assetId: z.uuid().nullable(),
  versionId: z.uuid().nullable(),
});
const signedUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
});
export const signedPartSchema = z.strictObject({
  url: signedUrl,
  headers: z.record(z.string(), z.string()),
  expiresAt: z.number(),
});
export const accessSchema = z.strictObject({
  url: signedUrl,
  expiresAt: z.number(),
});
export type UploadView = z.infer<typeof uploadViewSchema>;
export type PartPlan = z.infer<typeof partPlanSchema>;
export type CloudAsset = z.infer<typeof assetSchema>;
