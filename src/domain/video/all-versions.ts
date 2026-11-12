import { z } from "zod";
import { allVersionsDocumentSchema } from "./schema";
import { mediaVersionRefSchema } from "../cloud-library/schema";
import { toFrame } from "./time";
export const ALEO_HASH =
  "62b6cb49b7b087b341f0307ea3bc871a9690d8947691206ab025d149b8f6ed6f";
export const AV_RENDERER_PREVIOUS = "axfluxo-all-versions-v5.1";
export const AV_RENDERER = "axfluxo-all-versions-v5.2";
/**
 * Reference frame layout, in fractions of the video height. The text and
 * translucent band are rasterized together so all three previews/export paths
 * share the same typography and placement.
 */
export const AV_REFERENCE_LAYOUT = {
  coverSide: 1,
  coverCornerRadius: 0.042,
  backgroundOverscan: 1.25,
  backgroundBlur: 0.095,
  textCenterY: 0.5,
  textSize: 0.058,
  textMaxWidth: 0.94,
  textBandHeight: 0.069,
  textBandHorizontalPadding: 0.006,
  textBandOpacity: 0.6,
  textStroke: 0.004,
} as const;
export const projectCodes = [
  "PROJECT_CONFLICT",
  "PROJECT_NOT_FOUND",
  "PROJECT_INVALID",
  "FONT_UNAVAILABLE",
  "FONT_GLYPH_UNSUPPORTED",
  "NAME_COUNT",
  "EMPTY_NAME",
  "FADE_TOO_LONG",
  "VERSION_ZERO_FRAMES",
  "COVER_REQUIRED",
  "MEDIA_REQUIRED",
  "SYNC_OFFLINE",
  "LOCAL_QUOTA",
] as const;
export const allVersionsProjectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("all-versions-project"),
  id: z.uuid(),
  document: allVersionsDocumentSchema.nullable(),
  cover: mediaVersionRefSchema.refine((v) => v.kind === "image").nullable(),
  namesText: z.string(),
  removeNumbers: z.boolean(),
  design: z.strictObject({
    height: z.union([z.literal(1080), z.literal(1440)]),
    fadeInFrames: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    fadeOutFrames: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    fontHash: z.literal(ALEO_HASH),
    rendererVersion: z.union([
      z.literal(AV_RENDERER),
      z.literal(AV_RENDERER_PREVIOUS),
    ]),
    layout: z.literal("provisional-v1"),
  }),
});
export type AllVersionsProject = z.infer<typeof allVersionsProjectSchema>;
export function newProject(): AllVersionsProject {
  return {
    schemaVersion: 1,
    kind: "all-versions-project",
    id: crypto.randomUUID(),
    document: null,
    cover: null,
    namesText: "",
    removeNumbers: false,
    design: {
      height: 1080,
      fadeInFrames: 9,
      fadeOutFrames: 9,
      fontHash: ALEO_HASH,
      rendererVersion: AV_RENDERER,
      layout: "provisional-v1",
    },
  };
}
export function projectNames(p: AllVersionsProject) {
  return p.namesText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((s) =>
      p.removeNumbers
        ? s.replace(/^\s*(?:\d+[.)、:\-]\s*|\[\d+\]\s*)/u, "")
        : s,
    );
}
export function versionIntervals(p: AllVersionsProject) {
  let offset = 0;
  const list: { startFrame: number; endFrame: number; clipIndex: number }[] =
    [];
  p.document?.clips.forEach((c, clipIndex) => {
    const bounds = [c.interval.startUs, ...c.markersUs, c.interval.endUs];
    for (let i = 0; i + 1 < bounds.length; i++)
      list.push({
        startFrame: toFrame(offset + bounds[i] - c.interval.startUs),
        endFrame: toFrame(offset + bounds[i + 1] - c.interval.startUs),
        clipIndex,
      });
    offset += c.interval.endUs - c.interval.startUs;
  });
  return list;
}
export function projectIssues(p: AllVersionsProject) {
  const issues: string[] = [];
  if (!p.document) issues.push("MEDIA_REQUIRED");
  if (!p.cover) issues.push("COVER_REQUIRED");
  const versions = versionIntervals(p),
    names = projectNames(p);
  if (names.length !== versions.length) issues.push("NAME_COUNT");
  if (names.some((s) => !s.trim())) issues.push("EMPTY_NAME");
  if (versions.some((v) => v.endFrame <= v.startFrame))
    issues.push("VERSION_ZERO_FRAMES");
  if (
    versions.some(
      (v) =>
        v.endFrame - v.startFrame <
        p.design.fadeInFrames + p.design.fadeOutFrames,
    )
  )
    issues.push("FADE_TOO_LONG");
  return issues;
}
export function textAlpha(
  frame: number,
  version: { startFrame: number; endFrame: number },
  design: AllVersionsProject["design"],
) {
  if (frame < version.startFrame || frame >= version.endFrame) return 0;
  return Math.max(
    0,
    Math.min(
      1,
      design.fadeInFrames
        ? (frame - version.startFrame) / design.fadeInFrames
        : 1,
      design.fadeOutFrames
        ? (version.endFrame - frame) / design.fadeOutFrames
        : 1,
    ),
  );
}
