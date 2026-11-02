import { z } from "zod";
import { allVersionsDocumentSchema } from "./schema";
import { intervalSchema, toFrame } from "./time";
import { filenameSchema, keySchema } from "../cloud-library/schema";
export const FNF_HEADING = "HIGH QUALITY VERSION IS ON YOUTUBE";
export const FNF_RENDERER = "axfluxo-fnf-showcase-v6.1";
export const FNF_FONT_HASH =
  "c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f";
export const fnfCodes = [
  "FNF_INVALID_RANGE",
  "FNF_EMPTY_NAME",
  "FNF_INVALID_CROP",
  "FNF_PRESET_MISMATCH",
  "FNF_PREFERENCES_CONFLICT",
  "FNF_SOURCE_MISSING",
  "FNF_FONT_UNAVAILABLE",
  "FNF_INVALID_SNAPSHOT",
] as const;
export const fnfPreferencesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  username: z
    .string()
    .min(2)
    .max(200)
    .regex(/^@[^\s\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]+$/u),
  template: z.strictObject({
    presetWidth: z.number().int().positive().max(16384),
    presetHeight: z.number().int().positive().max(16384),
    cropTop: z.number().int().nonnegative().max(16384),
    cropBottom: z.number().int().nonnegative().max(16384),
    scale: z.number().positive().max(16),
    rendererVersion: z.literal(FNF_RENDERER),
    fontHash: z.literal(FNF_FONT_HASH),
  }),
});
export type FnfPreferences = z.infer<typeof fnfPreferencesSchema>;
export const defaultFnfPreferences = (): FnfPreferences => ({
  schemaVersion: 1,
  username: "@username",
  template: {
    presetWidth: 1920,
    presetHeight: 1080,
    cropTop: 0,
    cropBottom: 0,
    scale: 1080 / 1920,
    rendererVersion: FNF_RENDERER,
    fontHash: FNF_FONT_HASH,
  },
});
/** Explicit allowlist. This projection never contains a source, range, chart name or job. */
export function persistentFnfPreferences(p: FnfPreferences) {
  return fnfPreferencesSchema.parse({
    schemaVersion: p.schemaVersion,
    username: p.username,
    template: {
      presetWidth: p.template.presetWidth,
      presetHeight: p.template.presetHeight,
      cropTop: p.template.cropTop,
      cropBottom: p.template.cropBottom,
      scale: p.template.scale,
      rendererVersion: p.template.rendererVersion,
      fontHash: p.template.fontHash,
    },
  });
}
const encoder = new TextEncoder();
function stem(name: string) {
  let s = name
    .normalize("NFC")
    .replace(/\.mp4$/i, "")
    .replace(
      /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
      "_",
    )
    .trim()
    .replace(/[. ]+$/, "");
  if (!s) s = "chart";
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)) s = "_" + s;
  let result = "";
  for (const c of s) {
    if (
      result.length + c.length > 160 ||
      encoder.encode(result + c).length > 180
    )
      break;
    result += c;
  }
  return result.replace(/[. ]+$/, "") || "chart";
}
export function fnfFilenames(names: readonly string[]) {
  const used = new Set<string>();
  return names.map((name) => {
    const base = stem(name);
    let number = 1,
      filename = `${base}.mp4`;
    while (used.has(filename.normalize("NFC").toLowerCase()))
      filename = `${base} (${++number}).mp4`;
    filenameSchema.parse(filename);
    used.add(filename.normalize("NFC").toLowerCase());
    return filename;
  });
}
export const fnfShowcaseSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("fnf-showcase-snapshot"),
    id: keySchema,
    document: allVersionsDocumentSchema,
    ranges: z.array(intervalSchema).min(1),
    names: z.array(filenameSchema).min(1),
    chartNames: z
      .array(
        z
          .string()
          .refine((s) => s.trim().length > 0, { message: "FNF_EMPTY_NAME" }),
      )
      .min(1),
    creationOrders: z
      .array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
      .min(1),
    preferences: fnfPreferencesSchema,
  })
  .superRefine((s, ctx) => {
    const fail = () =>
      ctx.addIssue({ code: "custom", message: "FNF_INVALID_SNAPSHOT" });
    const clip = s.document.clips[0];
    if (
      s.document.clips.length !== 1 ||
      clip.source.kind !== "video" ||
      clip.interval.startUs !== 0 ||
      clip.interval.endUs !== clip.sourceDurationUs ||
      clip.markersUs.length
    )
      fail();
    if (
      s.ranges.length !== s.names.length ||
      s.names.length !== s.chartNames.length ||
      s.names.length !== s.creationOrders.length ||
      new Set(s.creationOrders).size !== s.creationOrders.length
    )
      fail();
    for (let i = 0; i < s.ranges.length; i++) {
      const r = s.ranges[i],
        previous = s.ranges[i - 1];
      if (
        r.endUs > clip.sourceDurationUs ||
        toFrame(r.endUs) <= toFrame(r.startUs) ||
        (previous &&
          (r.startUs < previous.startUs ||
            (r.startUs === previous.startUs &&
              s.creationOrders[i] < s.creationOrders[i - 1])))
      )
        fail();
    }
    if (JSON.stringify(fnfFilenames(s.chartNames)) !== JSON.stringify(s.names))
      fail();
  });
export type FnfShowcaseSnapshot = z.infer<typeof fnfShowcaseSnapshotSchema>;
export function isFnfShowcase(value: unknown): value is FnfShowcaseSnapshot {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: string }).kind === "fnf-showcase-snapshot"
  );
}
