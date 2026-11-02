import { z } from "zod";
import {
  fnfPreferencesSchema,
  FNF_FONT_HASH,
  FNF_RENDERER,
  type FnfPreferences,
  type FnfShowcaseSnapshot,
} from "../../domain/video/fnf-showcase";
import { mediaVersionRefSchema } from "../../domain/cloud-library/schema";
import { batchViewSchema } from "../../../server/contracts/video";
import type { AuthenticatedApi } from "../cloud-library/client";
export const fnfSourceSchema = z.strictObject({
  reference: mediaVersionRefSchema,
  durationUs: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  geometryVerified: z.boolean(),
});
const preferenceView = z.strictObject({
  preferences: fnfPreferencesSchema,
  revision: z.number().int().nonnegative(),
});
const overlayView = z.strictObject({
  png: z.string(),
  width: z.literal(1080),
  height: z.literal(1920),
  fontHash: z.literal(FNF_FONT_HASH),
  rendererVersion: z.literal(FNF_RENDERER),
});
export const fnfBatchViewSchema = z.strictObject({
  batch: batchViewSchema,
  items: z.array(
    z.strictObject({
      rangeIndex: z.number().int(),
      chartName: z.string(),
      filename: z.string(),
      startUs: z.number().int(),
      endUs: z.number().int(),
    }),
  ),
});
export type FnfBatchView = z.infer<typeof fnfBatchViewSchema>;
const batchesView = z.strictObject({
  items: z.array(z.strictObject({ id: z.uuid(), createdAt: z.string() })),
  nextCursor: z.uuid().nullable(),
});
export function fnfClient(api: AuthenticatedApi, owner: string) {
  const get = <T>(path: string, schema: z.ZodType<T>) =>
    api.request(path, schema, "GET", undefined, undefined, undefined, owner);
  const post = <T>(
    path: string,
    schema: z.ZodType<T>,
    body: unknown,
    key = crypto.randomUUID(),
    revision?: number,
  ) =>
    api.request(
      path,
      schema,
      "POST",
      body,
      key,
      revision === undefined ? undefined : `"${revision}"`,
      owner,
    );
  return {
    preferences: () => get("/preferences/fnf-showcase", preferenceView),
    savePreferences: (preferences: FnfPreferences, revision: number) =>
      post(
        "/preferences/fnf-showcase",
        preferenceView,
        preferences,
        crypto.randomUUID(),
        revision,
      ),
    source: (id: string) => get(`/fnf-showcase/source/${id}`, fnfSourceSchema),
    overlay: (preferences: FnfPreferences) =>
      post("/fnf-showcase/overlay", overlayView, preferences),
    submit: (snapshot: FnfShowcaseSnapshot, key: string) =>
      post("/fnf-showcase/batches", batchViewSchema, snapshot, key),
    batch: (id: string) =>
      get(`/fnf-showcase/batches/${id}`, fnfBatchViewSchema),
    batches: (cursor?: string) =>
      get(
        `/fnf-showcase/batches${cursor ? `?cursor=${cursor}` : ""}`,
        batchesView,
      ),
    progress: (id: string) =>
      get(
        `/render-jobs/${id}/progress`,
        z.object({
          jobId: z.string(),
          state: z.string(),
          runs: z.number(),
          completedFrames: z.number(),
          totalFrames: z.number(),
          errorCode: z.string().nullable(),
          retryAt: z.string().nullable(),
        }),
      ),
    api,
  };
}
