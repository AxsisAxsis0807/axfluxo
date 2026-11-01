import { concatenateFrames, toFrame } from "../../../src/domain/video/time";
import {
  fnfSnapshotSchema,
  type FnfSnapshot,
} from "../../../src/domain/video/schema";
import { digest } from "../../api/jobs";
import { RenderError } from "../jobs/errors";
export const RENDER_VERSION = "axfluxo-render-v4.1";
export type RenderMode = "fnf" | "all-versions";
export type Piece = {
  clipIndex: number;
  sourceStartUs: number;
  sourceEndUs: number;
  frames: number;
  outputStartFrame: number;
};
export type Segment = Piece & { index: number };
export function renderPlan(
  input: FnfSnapshot,
  index: number,
  mode: RenderMode = "fnf",
  segmentFrames = 1800,
) {
  const snapshot = fnfSnapshotSchema.parse(input);
  if (
    !Number.isSafeInteger(segmentFrames) ||
    segmentFrames < 1 ||
    segmentFrames > 18000
  )
    throw new RenderError("INPUT_UNSUPPORTED");
  const boundaries = concatenateFrames(
    snapshot.document.clips.map((c) => c.interval.endUs - c.interval.startUs),
  );
  const range = snapshot.ranges[index];
  if (!range) throw new RenderError("INPUT_UNSUPPORTED");
  const start = mode === "all-versions" ? 0 : toFrame(range.startUs),
    end =
      mode === "all-versions"
        ? boundaries.at(-1)!.endFrame
        : toFrame(range.endUs);
  const pieces: Piece[] = [];
  const segments: Segment[] = [];
  boundaries.forEach((b, clipIndex) => {
    const first = Math.max(start, b.startFrame),
      last = Math.min(end, b.endFrame);
    if (last <= first) return;
    const p = {
      clipIndex,
      sourceStartUs:
        snapshot.document.clips[clipIndex].interval.startUs +
        Math.round(((first - b.startFrame) * 1e6) / 60),
      sourceEndUs: snapshot.document.clips[clipIndex].interval.endUs,
      frames: last - first,
      outputStartFrame: first - start,
    };
    pieces.push(p);
    for (let n = 0; n < p.frames; n += segmentFrames)
      segments.push({
        ...p,
        index: segments.length,
        sourceStartUs: p.sourceStartUs + Math.round((n * 1e6) / 60),
        frames: Math.min(segmentFrames, p.frames - n),
        outputStartFrame: p.outputStartFrame + n,
      });
  });
  if (!pieces.length || end <= start || segments.length > 100000)
    throw new RenderError("RESOURCE_LIMIT");
  const dimensions =
    mode === "all-versions"
      ? { width: 1920, height: 1080 }
      : { width: 1080, height: 1920 };
  return {
    snapshot,
    index,
    mode,
    frames: end - start,
    pieces,
    segments,
    ...dimensions,
    hash: digest({
      version: RENDER_VERSION,
      snapshot,
      index,
      mode,
      segmentFrames,
      ...dimensions,
    }),
  };
}
export type RenderPlan = ReturnType<typeof renderPlan>;
