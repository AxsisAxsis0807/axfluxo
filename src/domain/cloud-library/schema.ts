import { z } from "zod";
export const keySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const filenameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (name) =>
      !/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(name) &&
      !/[. ]$/.test(name) &&
      name === name.trim() &&
      !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) &&
      name !== "." &&
      name !== "..",
    { message: "VIDEO_FILENAME" },
  );
export const mediaVersionRefSchema = z.strictObject({
  libraryId: keySchema,
  fileId: keySchema,
  versionId: keySchema,
  hash: hashSchema,
  kind: z.enum(["video", "audio", "image"]),
});
/** Metadata only; bytes belong to an adapter. Original identity is append-only. */
export const originalVersionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    reference: mediaVersionRefSchema,
    filename: filenameSchema,
    originalHash: hashSchema,
    byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mime: z.enum([
      "video/mp4",
      "video/webm",
      "audio/wav",
      "audio/ogg",
      "image/png",
    ]),
  })
  .readonly();
export type MediaVersionRef = z.infer<typeof mediaVersionRefSchema>;
