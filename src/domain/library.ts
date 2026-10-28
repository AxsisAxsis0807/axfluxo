import { z } from "zod";
const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
export const libraryReferenceSchema = z
  .object({
    scope: z.literal("library"),
    libraryId: key,
    fileId: key,
    versionId: key,
    kind: z.enum(["image", "file", "audio", "video"]),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const libraryFileSchema = z
  .object({
    id: key,
    libraryId: key,
    name: z.string().trim().min(1).max(200),
    kind: z.enum(["image", "file", "audio", "video"]),
    versionId: key,
    folderId: key.nullable(),
    createdAt: z.iso.datetime(),
    deleted: z.boolean(),
  })
  .strict();
export const folderSchema = z
  .object({
    id: key,
    name: z.string().trim().min(1).max(200),
    parentId: key.nullable(),
  })
  .strict();
export const versionMetadataSchema = z
  .object({
    id: key,
    fileId: key,
    libraryId: key,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
    size: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024),
    originalHash: z.string().regex(/^[a-f0-9]{64}$/),
    originalMime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  })
  .strict();
export type LibraryFile = z.infer<typeof libraryFileSchema>;
export type LibraryFolder = z.infer<typeof folderSchema>;
export type LibraryVersion = z.infer<typeof versionMetadataSchema> & {
  blob: Blob;
  original: Blob;
};
export type LibraryRef = z.infer<typeof libraryReferenceSchema>;
export const libraryRef = (v: LibraryVersion): LibraryRef => ({
  scope: "library",
  libraryId: v.libraryId,
  fileId: v.fileId,
  versionId: v.id,
  kind: "image",
  hash: v.hash,
});
