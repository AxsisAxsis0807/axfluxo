import { z } from "zod";
import {
  folderPageSchema,
  folderSchema,
  assetPageSchema,
  uploadStartSchema,
  uploadViewSchema,
  partPlanSchema,
  signedPartSchema,
  accessSchema,
} from "../../domain/cloud-library/media";
import { createVideoApiClient } from "../video/api-client";
export type AuthenticatedApi = ReturnType<typeof createVideoApiClient>;
export function cloudClient(auth: AuthenticatedApi) {
  const post = <T>(
    path: string,
    schema: z.ZodType<T>,
    body: unknown,
    key = crypto.randomUUID(),
  ) => auth.request(path, schema, "POST", body, key);
  const id = z.strictObject({ id: z.uuid() });
  return {
    me: auth.me,
    folders: (parentId: string | null, cursor?: string) =>
      auth.request(
        `/cloud/folders?${new URLSearchParams({ ...(parentId ? { parentId } : {}), ...(cursor ? { cursor } : {}) })}`,
        folderPageSchema,
      ),
    createFolder: (name: string, parentId: string | null) =>
      post("/cloud/folders", folderSchema, { name, parentId }),
    moveFolder: (folder: string, parentId: string | null) =>
      post(`/cloud/folders/${encodeURIComponent(folder)}/move`, id, {
        parentId,
      }),
    assets: (folderId: string | null, deleted = false, cursor?: string) =>
      auth.request(
        `/cloud/assets?${new URLSearchParams({ ...(folderId ? { folderId } : {}), deleted: String(deleted), ...(cursor ? { cursor } : {}) })}`,
        assetPageSchema,
      ),
    rename: (asset: string, name: string) =>
      post(`/cloud/assets/${encodeURIComponent(asset)}/rename`, id, { name }),
    moveAsset: (asset: string, folderId: string | null) =>
      post(`/cloud/assets/${encodeURIComponent(asset)}/move`, id, { folderId }),
    trash: (asset: string, deleted: boolean) =>
      post(
        `/cloud/assets/${encodeURIComponent(asset)}/${deleted ? "trash" : "restore"}`,
        id,
        {},
      ),
    start: (body: z.infer<typeof uploadStartSchema>, key: string) =>
      post("/cloud/uploads", uploadViewSchema, body, key),
    status: (upload: string) =>
      auth.request(
        `/cloud/uploads/${encodeURIComponent(upload)}`,
        uploadViewSchema,
      ),
    sign: (upload: string, plan: z.infer<typeof partPlanSchema>) =>
      post(
        `/cloud/uploads/${encodeURIComponent(upload)}/part`,
        signedPartSchema,
        plan,
      ),
    complete: (upload: string) =>
      post(
        `/cloud/uploads/${encodeURIComponent(upload)}/complete`,
        uploadViewSchema,
        {},
      ),
    abort: (upload: string) =>
      post(
        `/cloud/uploads/${encodeURIComponent(upload)}/abort`,
        uploadViewSchema,
        {},
      ),
    access: (version: string) =>
      auth.request(
        `/cloud/versions/${encodeURIComponent(version)}/access`,
        accessSchema,
      ),
  };
}
export type CloudClient = ReturnType<typeof cloudClient>;
