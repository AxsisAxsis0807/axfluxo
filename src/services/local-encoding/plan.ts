import {
  allVersionsProjectSchema,
  projectIssues,
  versionIntervals,
  type AllVersionsProject,
} from "../../domain/video/all-versions";
import { fnfShowcaseSnapshotSchema } from "../../domain/video/fnf-showcase";
import { toFrame } from "../../domain/video/time";
import type { Snapshot } from "./storage";
export const WORK_MS = 10 * 60 * 1000;
export const REST_MS = 4 * 60 * 1000;
export const CHUNK_FRAMES = 120;
export type LocalPiece = {
  clipIndex: number;
  sourceStartUs: number;
  frames: number;
  version: number;
  versionFrame: number;
  versionFrames: number;
};
export function validate(snapshot: Snapshot): Snapshot {
  if (snapshot.kind === "all-versions-project") {
    const p = allVersionsProjectSchema.parse(snapshot),
      issues = projectIssues(p);
    if (issues.length) throw Error(issues.join(", "));
    return p;
  }
  return fnfShowcaseSnapshotSchema.parse(snapshot);
}
export function plan(snapshot: Snapshot, index = 0): LocalPiece[] {
  validate(snapshot);
  const pieces: LocalPiece[] = [];
  if (snapshot.kind === "all-versions-project") {
    const p = snapshot as AllVersionsProject;
    let clipOffset = 0;
    const offsets = p.document!.clips.map((c) => {
      const old = clipOffset;
      clipOffset += c.interval.endUs - c.interval.startUs;
      return old;
    });
    versionIntervals(p).forEach((v, version) => {
      const c = p.document!.clips[v.clipIndex];
      for (let f = v.startFrame; f < v.endFrame; f += CHUNK_FRAMES)
        pieces.push({
          clipIndex: v.clipIndex,
          sourceStartUs:
            c.interval.startUs +
            Math.round((f * 1e6) / 60) -
            offsets[v.clipIndex],
          frames: Math.min(CHUNK_FRAMES, v.endFrame - f),
          version,
          versionFrame: f - v.startFrame,
          versionFrames: v.endFrame - v.startFrame,
        });
    });
  } else {
    const r = snapshot.ranges[index];
    if (!r) throw Error("FNF_INVALID_RANGE");
    const frames = toFrame(r.endUs) - toFrame(r.startUs);
    for (let f = 0; f < frames; f += CHUNK_FRAMES)
      pieces.push({
        clipIndex: 0,
        sourceStartUs: Math.round(((toFrame(r.startUs) + f) * 1e6) / 60),
        frames: Math.min(CHUNK_FRAMES, frames - f),
        version: 0,
        versionFrame: f,
        versionFrames: frames,
      });
  }
  return pieces;
}
export function refs(snapshot: Snapshot) {
  const result = snapshot.document?.clips.map((c) => c.source) ?? [];
  if (snapshot.kind === "all-versions-project" && snapshot.cover)
    result.push(snapshot.cover);
  return result;
}
