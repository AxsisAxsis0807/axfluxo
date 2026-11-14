import { it, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newProject, versionIntervals } from "../../../src/domain/video/all-versions";
import { allVersionsDocumentSchema } from "../../../src/domain/video/schema";
import { encodeProjectSegment, prepareGraphics } from "../../worker/templates/all-versions/render";
import type { RenderPlan, Segment } from "../../worker/render/plan";

function timerRegion(path: string, frame: number): Buffer {
  return execFileSync("ffmpeg", [
    "-v", "error", "-i", path, "-vf",
    `select='eq(n,${frame})',crop=300:70:810:914,format=rgb24`,
    "-frames:v", "1", "-f", "rawvideo", "-",
  ], { maxBuffer: 300 * 70 * 3 + 16384 });
}
function meanAbsolutePixelDifference(a: Buffer, b: Buffer) {
  expect(a.length).toBe(b.length);
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

function frames(path: string): number {
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames,width,height,r_frame_rate",
    "-of", "json", path,
  ], { encoding: "utf8" }));
  const s = probe.streams[0];
  expect(s.width).toBe(1920);
  expect(s.height).toBe(1080);
  expect(s.r_frame_rate).toBe("60/1");
  return Number(s.nb_read_frames);
}

it("renders reference title and resettable mm:ss clock using real FFmpeg across segment boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axfluxo-av-reference-"));
  try {
    const cover = createCanvas(64, 64);
    const context = cover.getContext("2d");
    context.fillStyle = "#152c40";
    context.fillRect(0, 0, 64, 64);
    context.fillStyle = "#b6d3e7";
    context.fillRect(12, 12, 40, 40);
    const coverPath = join(dir, "cover.png");
    await writeFile(coverPath, await cover.encode("png"));
    const p = newProject();
    p.design.layout = "reference-pasa-v1";
    p.design.fadeInFrames = 9;
    p.design.fadeOutFrames = 9;
    p.cover = {
      libraryId: "cloud", fileId: randomUUID(), versionId: randomUUID(),
      hash: "a".repeat(64), kind: "image",
    };
    p.namesText = "PASA!(NORMAL)\nPASA!(SLOWED)";
    p.document = allVersionsDocumentSchema.parse({
      schemaVersion: 1,
      kind: "all-versions",
      id: randomUUID(),
      revision: 0,
      fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
      clips: [{
        id: randomUUID(),
        source: {
          libraryId: "cloud", fileId: randomUUID(), versionId: randomUUID(),
          hash: "b".repeat(64), kind: "audio",
        },
        sourceDurationUs: 3_000_000,
        interval: { startUs: 0, endUs: 3_000_000 },
        markersUs: [1_500_000],
      }],
    });
    expect(versionIntervals(p).map(v => [v.startFrame, v.endFrame])).toEqual([
      [0, 90], [90, 180],
    ]);
    const graphics = await prepareGraphics(p, coverPath, dir);
    const plan = { width: 1920, height: 1080 } as RenderPlan;
    const segments = [
      { start: 0, length: 30 },
      { start: 60, length: 30 },
      { start: 90, length: 30 },
      { start: 150, length: 30 },
    ];
    const files: string[] = [];
    for (const [i, s] of segments.entries()) {
      const path = join(dir, `part-${i}.mp4`);
      await encodeProjectSegment(
        p,
        { outputStartFrame: s.start, frames: s.length } as Segment,
        plan, graphics, dir, path,
      );
      expect(frames(path)).toBe(s.length);
      files.push(path);
    }
    // At relative frame 20 in either version, the same 00:01 should be shown.
    // Different title text changes H.264 macroblock decisions. Compare the
    // displayed clock region with a measured tolerance instead of exact bytes.
    expect(meanAbsolutePixelDifference(
      timerRegion(files[0], 20),
      timerRegion(files[2], 20),
    )).toBeLessThan(6);
    // The first version advances at +66 frames, including across the split.
    expect(timerRegion(files[1], 5).equals(timerRegion(files[1], 6))).toBe(false);
    // Timer and title alpha fade in: first output frame and a later one differ.
    expect(timerRegion(files[0], 0).equals(timerRegion(files[0], 20))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
