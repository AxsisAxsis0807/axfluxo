/**
 * All Versions layout measured from a 910x512, 30fps NORMAL/SLOWED reference.
 * Measurements are observational, not exact InShot font/blur/keyframe settings.
 * All timings are in the existing 60fps renderer's integer frame domain.
 */
export const ALL_VERSIONS_REFERENCE = {
  width: 910,
  height: 512,
  coverSize: 506,
  coverTop: 3,
  backgroundZoom: 0.98,
  backgroundBlurRatio: 0.17,
  backgroundShade: 0.02,
  titleMaxWidthRatio: 0.88,
  titleBandPadding: 8,
  titleCenterY: 255.5,
  titleBandTop: 238,
  titleBandHeight: 35,
  titleFontSize: 28,
  titleStrokeRatio: 0.06,
  timerCenterY: 448,
  timerFontSize: 14, // calibrated against 30fps reference
  fadeInFrames: 54, // 0.9 seconds at 60fps
  fadeOutFrames: 42, // 0.7 seconds at 60fps
  titleOpacityScale: 0.95,
  timerOpacityScale: 0.85,
  titleBandAlpha: 0.58,
  titleFirstEntryExponent: 3.4,
  titleEntryExponent: 3.8,
  titleEntryFloor: 0.05,
  titleExitExponent: 2.6,
  timerEntryExponent: 0.83,
  timerExitExponent: 0.86,
  timerHoldFrames: 6,
} as const;

export type VersionWindow = { startFrame: number; endFrame: number };
export type ReferenceTrack = "title" | "timer";
const REF = ALL_VERSIONS_REFERENCE;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Shared fade boundaries; title and clock use their own measured-shape approximation.
 * The reference MP4 supports these approximations, not exact original easing parameters.
 */
export function referenceOpacity(
  frame: number,
  version: VersionWindow,
  fadeInFrames: number,
  fadeOutFrames: number,
  track: ReferenceTrack,
): number {
  if (frame < version.startFrame || frame >= version.endFrame) return 0;
  const position = frame - version.startFrame;
  const length = version.endFrame - version.startFrame;
  const inT = fadeInFrames ? clamp01(position / fadeInFrames) : 1;
  const outT = fadeOutFrames
    ? clamp01((position - (length - fadeOutFrames)) / fadeOutFrames)
    : 0;
  // Exponents were tuned against the uploaded 30fps fade samples (first
  // appearance, subsequent appearance, and both end transitions).
  // Keep the FFmpeg equations in reference-render.ts mathematically matched.
  const firstVersion = version.startFrame === 0;
  const entry =
    track === "title"
      ? (firstVersion ? 0 : REF.titleEntryFloor) +
        (firstVersion ? 1 : 1 - REF.titleEntryFloor) *
          (1 -
            Math.pow(
              1 - inT,
              firstVersion
                ? REF.titleFirstEntryExponent
                : REF.titleEntryExponent,
            ))
      : 0.5 - 0.5 * Math.cos(Math.PI * Math.pow(inT, REF.timerEntryExponent));
  const exit =
    track === "title"
      ? 1 - Math.pow(outT, REF.titleExitExponent)
      : 0.5 + 0.5 * Math.cos(Math.PI * Math.pow(outT, REF.timerExitExponent));
  return clamp01(
    entry *
      exit *
      (track === "title"
        ? ALL_VERSIONS_REFERENCE.titleOpacityScale
        : ALL_VERSIONS_REFERENCE.timerOpacityScale),
  );
}

/** 00:01 at version start; 00:02 at local frame #66 (1.1s at 60fps).
 * Uses integer frames to avoid segment boundary and floating-point drift.
 */
export function referenceTimerSeconds(
  frame: number,
  version: VersionWindow,
): number {
  const elapsed = Math.max(0, frame - version.startFrame);
  return 1 + Math.floor(Math.max(0, elapsed - REF.timerHoldFrames) / 60);
}

export function referenceTimerText(
  frame: number,
  version: VersionWindow,
): string {
  const total = referenceTimerSeconds(frame, version);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export type AllVersionsLayout = "provisional-v1" | "reference-pasa-v1";

export function referenceTitleSize(
  base: number,
  width: number,
  measured: number,
) {
  return Math.min(
    base,
    (base * width * ALL_VERSIONS_REFERENCE.titleMaxWidthRatio) /
      Math.max(1, measured),
  );
}
