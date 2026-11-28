import { it, expect } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newProject, projectIssues, versionIntervals } from "../../../src/domain/video/all-versions";
import { allVersionsDocumentSchema } from "../../../src/domain/video/schema";
import { backgroundImage } from "../../worker/templates/all-versions/graphics";
import { encodeProjectSegment, prepareGraphics } from "../../worker/templates/all-versions/render";
import { REFERENCE_BACKGROUND } from "../../../src/domain/video/all-versions-reference";
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
    const p = newProject();
    p.design.layout = "reference-pasa-v1";
    p.design.fadeInFrames = 9;
    p.design.fadeOutFrames = 9;
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
    expect(projectIssues(p)).toEqual([]);
    const fallback = await prepareGraphics(p, undefined, dir);
    const background = await loadImage(fallback.bg);
    const expected = createCanvas(1920, 1080).getContext("2d");
    expected.imageSmoothingQuality = "high";
    expected.drawImage(await loadImage(join("public", REFERENCE_BACKGROUND)), 0, 0, 1920, 1080);
    const actual = createCanvas(1920, 1080).getContext("2d");
    actual.drawImage(background, 0, 0);
    expect(Buffer.from(actual.getImageData(0, 0, 1920, 1080).data).equals(
      Buffer.from(expected.getImageData(0, 0, 1920, 1080).data),
    )).toBe(true);
    const cover = createCanvas(48, 24);
    const paint = cover.getContext("2d");
    paint.fillStyle = "#eb351c";
    paint.fillRect(0, 0, 48, 12);
    paint.fillStyle = "#1829ed";
    paint.fillRect(0, 12, 48, 12);
    const coverPath = join(dir, "cover.jpg");
    await writeFile(coverPath, await cover.encode("jpeg", 95));
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
    for (const file of [files[0], files[2]]) {
      const pixels = execFileSync("ffmpeg", [
        "-v", "error", "-i", file, "-frames:v", "1",
        "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
      ], { maxBuffer: 7 * 1024 ** 2 });
      expect(pixels.length).toBe(1920 * 1080 * 3);
      const sample = (x: number, y: number) => pixels.subarray((y * 1920 + x) * 3);
      const coverPixel = sample(960, 480);
      expect(coverPixel[0] - coverPixel[2]).toBeGreaterThan(120);
      const blurredPixel = sample(1610, 540);
      expect(Math.min(blurredPixel[0], blurredPixel[2])).toBeGreaterThan(70);
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

it("keeps the selected cover sharp and blurs a full-frame copy into the sides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axfluxo-av-cover-"));
  try {
    const p = newProject();
    p.design.layout = "reference-pasa-v1";
    const cover = createCanvas(24, 48);
    const source = cover.getContext("2d");
    const output = createCanvas(1920, 1080).getContext("2d");
    for (const [color, channel, format] of [
      ["#ee301c", 0, "png"], ["#2448ee", 2, "webp"],
    ] as const) {
      const path = join(dir, `cover.${format}`);
      source.clearRect(0, 0, cover.width, cover.height);
      source.fillStyle = color;
      source.fillRect(0, 12, cover.width, 24);
      const buffer = format === "png" ? await cover.encode("png") : await cover.encode("webp");
      await writeFile(path, buffer);
      output.drawImage(await loadImage(await backgroundImage(p, path)), 0, 0);
      for (const x of [960, 1610]) {
        const pixel = output.getImageData(x, 480, 1, 1).data;
        expect(pixel[channel] - pixel[2 - channel]).toBeGreaterThan(60);
      }
      const center = output.getImageData(960, 480, 1, 1).data;
      const backdrop = output.getImageData(400, 540, 1, 1).data;
      expect(center[channel]).toBeGreaterThan(backdrop[channel] + 10);
    }
    const split = createCanvas(128, 128);
    const paint = split.getContext("2d");
    paint.fillStyle = "#ff0000";
    paint.fillRect(0, 0, 128, 64);
    paint.fillStyle = "#0000ff";
    paint.fillRect(0, 64, 128, 64);
    const splitPath = join(dir, "split.png");
    await writeFile(splitPath, await split.encode("png"));
    output.drawImage(await loadImage(await backgroundImage(p, splitPath)), 0, 0);
    const rgb = (x: number, y: number) => Array.from(output.getImageData(x, y, 1, 1).data);
    const transition = rgb(140, 540);
    expect(transition[0]).toBeGreaterThan(70);
    expect(transition[2]).toBeGreaterThan(70);
    expect(rgb(960, 520)).toEqual([255, 0, 0, 255]);
    expect(rgb(960, 560)).toEqual([0, 0, 255, 255]);
    expect(rgb(421, 1)[0]).toBeLessThan(240);
    expect(rgb(475, 1)).toEqual([255, 0, 0, 255]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
