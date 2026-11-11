import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { StoredSpec } from "./queue";
import {
  fnfSnapshotSchema,
  type FnfSnapshot,
} from "../../src/domain/video/schema";
import { allVersionsProjectSchema } from "../../src/domain/video/all-versions";
import { projectPlan, prepareGraphics, encodeProjectSegment } from "../worker/templates/all-versions/render";
import { probe, type Track } from "../worker/render/process";
import { assemble, type Input } from "../worker/render/encode";
import { validateVideo } from "../worker/validation/output";
import { RenderError } from "../worker/jobs/errors";
import { decimalUs } from "../worker/derivatives/generate";

export type ExportSource = {
  blobId: string;
  path: string;
  hash: string;
};
export type ExportCover = ExportSource;

export const exportFileHash = async (path: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

/** A video input must contain exactly one decodable video stream. */
export function videoTrack(info: Awaited<ReturnType<typeof probe>>): Track {
  const videos = info.streams.filter((t) => t.codec_type === "video");
  if (videos.length !== 1) throw new RenderError("INPUT_UNSUPPORTED");
  if (!/^(h264|hevc|av1|vp9|mpeg4)$/.test(videos[0].codec_name))
    throw new RenderError("INPUT_UNSUPPORTED");
  return videos[0];
}

export function snapshotFor(
  spec: StoredSpec,
  jobId: string,
  sources: { blobId: string; hash: string; durationUs: number }[],
): FnfSnapshot {
  const clips = spec.clips.map((clip, index) => ({
    id: `clip-${index}`,
    source: {
      libraryId: "cloud-export",
      fileId: sources[index].blobId,
      versionId: "original",
      hash: sources[index].hash,
      kind: "video" as const,
    },
    sourceDurationUs: sources[index].durationUs,
    interval: { startUs: clip.startUs, endUs: clip.endUs },
    markersUs: clip.markersUs,
  }));
  const total = clips.reduce(
    (sum, c) => sum + (c.interval.endUs - c.interval.startUs),
    0,
  );
  return fnfSnapshotSchema.parse({
    schemaVersion: 1,
    id: jobId,
    document: {
      schemaVersion: 1,
      kind: "all-versions",
      id: `doc-${jobId}`,
      revision: 0,
      clips,
      fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
    },
    ranges: [{ startUs: 0, endUs: total }],
    names: ["export.mp4"],
  });
}

export function projectFor(
  spec: StoredSpec,
  jobId: string,
  snapshot: FnfSnapshot,
  cover: { blobId: string; hash: string },
) {
  return allVersionsProjectSchema.parse({
    schemaVersion: 1,
    kind: "all-versions-project",
    id: jobId,
    document: snapshot.document,
    cover: {
      libraryId: "cloud-export",
      fileId: cover.blobId,
      versionId: "original",
      hash: cover.hash,
      kind: "image",
    },
    namesText: spec.names.join("\n"),
    removeNumbers: false,
    design: {
      height: spec.design.height,
      fadeInFrames: spec.design.fadeInFrames,
      fadeOutFrames: spec.design.fadeOutFrames,
      fontHash: spec.design.fontHash,
      rendererVersion: spec.design.rendererVersion,
      layout: spec.design.layout,
    },
  });
}

/**
 * Reuses the existing All Versions renderer unchanged: same plan, graphics,
 * encoder, assembly and output validation as the existing local tooling.
 */
export async function renderExport(input: {
  jobId: string;
  spec: StoredSpec;
  directory: string;
  sources: ExportSource[];
  cover: ExportCover;
  segmentFrames: number;
  signal: AbortSignal;
  onProgress: (frames: number) => Promise<void>;
}) {
  const infos: Input[] = [];
  for (let i = 0; i < input.sources.length; i++) {
    const source = input.sources[i];
    input.signal.throwIfAborted();
    const info = await probe(source.path, input.signal);
    videoTrack(info);
    const durationUs = decimalUs(info.format.duration);
    const clip = input.spec.clips[i];
    if (
      !Number.isSafeInteger(durationUs) ||
      durationUs <= 0 ||
      clip.endUs > durationUs + 2
    )
      throw new RenderError("INPUT_CORRUPT");
    infos[i] = { path: source.path, info };
  }
  const snapshot = snapshotFor(
    input.spec,
    input.jobId,
    input.sources.map((source, i) => ({
      blobId: source.blobId,
      hash: source.hash,
      durationUs: decimalUs(infos[i].info.format.duration),
    })),
  );
  const project = projectFor(
    input.spec,
    input.jobId,
    snapshot,
    input.cover,
  );
  const plan = projectPlan(project, snapshot, input.segmentFrames);
  const graphics = await prepareGraphics(project, input.cover.path, input.directory);
  const paths: string[] = [];
  for (const segment of plan.segments) {
    input.signal.throwIfAborted();
    const path = join(input.directory, `segment-${segment.index}.mp4`);
    await encodeProjectSegment(
      project,
      segment,
      plan,
      graphics,
      input.directory,
      path,
      input.signal,
    );
    await validateVideo(
      path,
      { width: plan.width, height: plan.height, frames: segment.frames },
      input.signal,
    );
    paths.push(path);
    await input.onProgress(segment.outputStartFrame + segment.frames);
  }
  input.signal.throwIfAborted();
  const result = await assemble(
    plan,
    infos,
    paths,
    input.directory,
    input.signal,
    true,
  );
  const validation = await validateVideo(
    result.path,
    {
      width: plan.width,
      height: plan.height,
      frames: plan.frames,
      audio: true,
    },
    input.signal,
  );
  return {
    path: result.path,
    size: validation.size,
    sha256: validation.sha256,
    width: validation.width,
    height: validation.height,
    frames: validation.frames,
    durationUs: validation.durationUs,
    validation,
  };
}
