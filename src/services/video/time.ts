import { microsecondsSchema, toFrame } from "../../domain/video/time";
export { toFrame };
export function frameTimeUs(
  frame: number,
  rate = { numerator: 60, denominator: 1 },
) {
  if (
    !Number.isSafeInteger(frame) ||
    frame < 0 ||
    !Number.isSafeInteger(rate.numerator) ||
    rate.numerator <= 0 ||
    !Number.isSafeInteger(rate.denominator) ||
    rate.denominator <= 0
  )
    throw new Error("INVALID_INTERVAL");
  const n = BigInt(frame) * 1_000_000n * BigInt(rate.denominator),
    d = BigInt(rate.numerator);
  return microsecondsSchema.parse(Number((n + d / 2n) / d));
}
export function stepTime(us: number, frames: number) {
  microsecondsSchema.parse(us);
  if (!Number.isSafeInteger(frames)) throw new Error("INVALID_INTERVAL");
  return frameTimeUs(Math.max(0, toFrame(us) + frames));
}
export function secondsToUs(seconds: number) {
  if (!Number.isFinite(seconds)) throw new Error("INVALID_INTERVAL");
  return microsecondsSchema.parse(Math.max(0, Math.round(seconds * 1_000_000)));
}
export function formatTime(us: number) {
  microsecondsSchema.parse(us);
  const n = BigInt(us),
    s = n / 1_000_000n;
  return `${(s / 3600n).toString().padStart(2, "0")}:${((s / 60n) % 60n).toString().padStart(2, "0")}:${(s % 60n).toString().padStart(2, "0")}.${(n % 1_000_000n).toString().padStart(6, "0")}`;
}
export function parseTime(text: string) {
  if (text.length > 64) throw new Error("INVALID_INTERVAL");
  const pieces = text.normalize("NFKC").trim().split(":");
  if (pieces.length > 3 || !pieces.length) throw new Error("INVALID_INTERVAL");
  const last = /^(\d+)(?:\.(\d{1,6}))?$/.exec(pieces.pop()!);
  if (!last || pieces.some((v) => !/^\d+$/.test(v)))
    throw new Error("INVALID_INTERVAL");
  const seconds = BigInt(last[1]);
  if (pieces.length && seconds >= 60n) throw new Error("INVALID_INTERVAL");
  let total = seconds;
  if (pieces.length === 1) total += BigInt(pieces[0]) * 60n;
  if (pieces.length === 2) {
    if (BigInt(pieces[1]) >= 60n) throw new Error("INVALID_INTERVAL");
    total += BigInt(pieces[0]) * 3600n + BigInt(pieces[1]) * 60n;
  }
  return microsecondsSchema.parse(
    Number(total * 1_000_000n + BigInt((last[2] ?? "").padEnd(6, "0") || 0)),
  );
}
export type PreviewRange = {
  id: string;
  startUs: number;
  endUs: number;
  name: string;
};
export function validateRange(
  range: Pick<PreviewRange, "startUs" | "endUs">,
  durationUs: number,
) {
  microsecondsSchema.parse(durationUs);
  microsecondsSchema.parse(range.startUs);
  microsecondsSchema.parse(range.endUs);
  if (
    range.startUs >= range.endUs ||
    range.endUs > durationUs ||
    toFrame(range.endUs) <= toFrame(range.startUs)
  )
    throw new Error("INVALID_INTERVAL");
}
/** Independent FNF ranges deliberately permit overlaps. No persistent/edit-document codec. */
export function moveRange(
  range: PreviewRange,
  deltaUs: number,
  durationUs: number,
) {
  const length = range.endUs - range.startUs;
  const startUs = Math.round(
    Math.min(durationUs - length, Math.max(0, range.startUs + deltaUs)),
  );
  const next = { ...range, startUs, endUs: startUs + length };
  validateRange(next, durationUs);
  return next;
}
export type ClipInterval = {
  id: string;
  interval: { startUs: number; endUs: number };
};
export function clipAt(clips: readonly ClipInterval[], timeUs: number) {
  let offset = 0;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i],
      length = clip.interval.endUs - clip.interval.startUs;
    if (timeUs < offset + length || i === clips.length - 1)
      return {
        index: i,
        sourceUs: Math.min(
          clip.interval.endUs,
          clip.interval.startUs + Math.max(0, timeUs - offset),
        ),
        offsetUs: offset,
      };
    offset += length;
  }
  throw new Error("SOURCE_MISSING");
}
