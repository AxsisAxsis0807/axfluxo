import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WaveformResult } from "../../../src/services/video/local-waveform";
let bundle: string;
let dir: string;
const formats = ["mp3", "wav", "m4a", "mp4", "mov"];
test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "waveform-"));
  for (const format of [...formats, "silent.mp4", "long.m4a", "large.mov"]) {
    const video = ["mp4", "mov", "silent.mp4", "large.mov"].includes(format);
    const args = ["-v", "error", "-y"];
    if (video)
      args.push(
        "-f",
        "lavfi",
        "-i",
        format === "large.mov"
          ? "color=black:size=32x32:rate=1:duration=363"
          : "color=black:size=32x32:rate=1:duration=8",
      );
    if (format !== "silent.mp4")
      args.push(
        "-f",
        "lavfi",
        "-i",
        format === "long.m4a" || format === "large.mov"
          ? `sine=frequency=440:sample_rate=8000:duration=${format === "large.mov" ? 363 : 603}`
          : "aevalsrc=if(between(t\\,1\\,2)+between(t\\,4.5\\,5.5)\\,0.5*sin(2*PI*440*t)\\,0):s=48000:d=8",
        "-c:a",
        format === "mp3"
          ? "libmp3lame"
          : format === "wav"
            ? "pcm_s16le"
            : "aac",
      );
    if (video)
      args.push("-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p");
    args.push(join(dir, format.includes(".") ? format : `source.${format}`));
    execFileSync("ffmpeg", args);
  }
  bundle = (
    await build({
      entryPoints: [
        new URL("local-waveform-fixture.tsx", import.meta.url).pathname,
      ],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"test"' },
    })
  ).outputFiles[0].text;
});
async function open(page: Page) {
  await page.route("https://waveform.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
    }),
  );
  await page.goto("https://waveform.test/");
  await page.addScriptTag({ content: bundle });
}
async function analyze(
  page: Page,
  name: string,
  duration = 8,
  padding = false,
) {
  const bytes = await readFile(join(dir, name));
  return page.evaluate(
    async ({ bytes, name, duration, padding }) => {
      const api = window as unknown as {
        analyzeLocalWaveform: (
          file: File,
          duration: number,
          signal: AbortSignal,
          update: (value: WaveformResult) => void,
        ) => Promise<WaveformResult>;
      };
      const parts: BlobPart[] = [new Uint8Array(bytes)];
      if (padding) {
        const free = new Uint8Array(33 * 1024 * 1024);
        new DataView(free.buffer).setUint32(0, free.length);
        free.set([102, 114, 101, 101], 4);
        parts.push(free);
      }
      // No AudioDecoder required; no complete File.arrayBuffer() allowed.
      Object.defineProperty(window, "AudioDecoder", {
        value: undefined,
        configurable: true,
      });
      const file = new File(parts, name);
      file.arrayBuffer = () => {
        throw Error("whole-file decode forbidden");
      };
      const progress: number[] = [];
      const result = await api.analyzeLocalWaveform(
        file,
        duration,
        new AbortController().signal,
        (value) => progress.push(value.progress),
      );
      return { result, progress, size: file.size };
    },
    { bytes: [...bytes], name, duration, padding },
  );
}
for (const format of formats)
  test(`automatic ${format} peaks align with tone/silence without AudioDecoder`, async ({
    page,
  }) => {
    await open(page);
    const { result } = await analyze(page, `source.${format}`);
    expect(result.status).toBe("complete");
    expect(result.waveform!.sampleRate).toBe(48000);
    const level = result.waveform!.levels[0];
    const peakAt = (seconds: number) =>
      level.peaks[Math.floor((seconds * 1e6) / level.stepUs) * 2 + 1];
    expect(peakAt(0.5)).toBeLessThan(0.03);
    expect(peakAt(1.5)).toBeGreaterThan(0.3);
    expect(peakAt(3)).toBeLessThan(0.03);
    expect(peakAt(4.8)).toBeGreaterThan(0.3);
    expect(peakAt(6)).toBeLessThan(0.03);
    await page.getByLabel("files").setInputFiles(join(dir, `source.${format}`));
    await expect(
      page.getByText("音声波形の解析完了", { exact: true }),
    ).toBeVisible();
    expect(
      await page
        .getByRole("button", { name: "波形を生成", exact: true })
        .count(),
    ).toBe(0);
    const pixels = await page
      .getByLabel("音声波形", { exact: true })
      .evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        return [
          ...canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data,
        ].some((value, i) => i % 4 === 3 && value > 0);
      });
    expect(pixels).toBe(true);
  });
test("large MOV, long audio, and silent video are handled without old limits", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await open(page);
  const large = await analyze(page, "large.mov", 363, true);
  expect(large.size).toBeGreaterThan(32 * 1024 * 1024);
  expect(large.result.status).toBe("complete");
  const long = await analyze(page, "long.m4a", 603);
  expect(long.result.status).toBe("complete");
  expect(long.result.waveform!.levels[0].peaks.length).toBeLessThanOrEqual(
    40002,
  );
  expect(long.progress.some((p) => p > 0 && p < 1)).toBe(true);
  expect((await analyze(page, "silent.mp4")).result.status).toBe("no-audio");
});
test("cancel, retry, remove/re-add, independent files, editing, zoom and interruption", async ({
  page,
}) => {
  await open(page);
  await page
    .getByLabel("files")
    .setInputFiles([join(dir, "long.m4a"), join(dir, "source.wav")]);
  await page
    .getByRole("button", { name: "トリミング範囲を編集", exact: true })
    .first()
    .click();
  const editing = page.getByRole("button", {
    name: "long.m4a 終了handle",
    exact: true,
  });
  await editing.focus();
  await editing.press("ArrowLeft");
  await expect(page.getByLabel("edited", { exact: true })).not.toHaveText("8");
  await page
    .getByRole("button", { name: "波形解析をキャンセル", exact: true })
    .first()
    .click();
  await expect(page.getByText(/波形解析をキャンセルしました/)).toBeVisible();
  await expect(
    page.getByText("音声波形の解析完了", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "long.m4a 終了handle", exact: true })
    .focus();
  await page
    .getByRole("button", { name: "long.m4a 終了handle", exact: true })
    .press("ArrowLeft");
  await expect(page.getByLabel("edited", { exact: true })).not.toHaveText("8");
  await page.getByRole("button", { name: "拡大", exact: true }).first().click();
  await page
    .getByTestId("video-timeline")
    .first()
    .evaluate((node) => {
      node.scrollLeft = 100;
    });
  await page.getByRole("button", { name: "波形を再解析", exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByText(/画面の中断により/)).toBeVisible();
  await page.getByRole("button", { name: "remove", exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
  });
  await page.getByLabel("files").setInputFiles(join(dir, "source.mp3"));
  await expect(
    page.getByText("音声波形の解析完了", { exact: true }),
  ).toBeVisible();
});
test("invalid audio fails without disabling timeline editing", async ({
  page,
}) => {
  await open(page);
  await page.getByLabel("files").setInputFiles({
    name: "bad.mov",
    mimeType: "video/quicktime",
    buffer: Buffer.from("invalid"),
  });
  await expect(
    page.getByText(/この素材の音声形式を端末で解析できません/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "トリミング範囲を編集", exact: true })
    .click();
  const handle = page.getByRole("button", {
    name: "bad.mov 終了handle",
    exact: true,
  });
  await handle.focus();
  await handle.press("ArrowLeft");
  await expect(page.getByLabel("edited", { exact: true })).not.toHaveText("8");
});
test("visible-window refinement uses real finer peaks with source origin and bounded storage", async ({
  page,
}) => {
  await open(page);
  const bytes = await readFile(join(dir, "source.wav"));
  const result = await page.evaluate(async (bytes) => {
    const api = window as unknown as {
      analyzeLocalWaveform: typeof import("../../../src/services/video/local-waveform").analyzeLocalWaveform;
    };
    const source = new File([new Uint8Array(bytes)], "source.wav");
    const overview = await api.analyzeLocalWaveform(
      source,
      8,
      new AbortController().signal,
      () => {},
    );
    const detail = await api.analyzeLocalWaveform(
      source,
      8,
      new AbortController().signal,
      () => {},
      { start: 0.75, end: 1.25, step: 1 / 48000 },
    );
    return { overview, detail };
  }, Array.from(bytes));
  const level = result.detail.waveform!.levels[0];
  expect(result.detail.waveform!.originUs).toBe(750000);
  expect(level.stepUs).toBeLessThan(
    result.overview.waveform!.levels[0].stepUs / 10,
  );
  expect(level.peaks.length).toBeLessThanOrEqual(40002);
  const onset = Math.floor(250000 / level.stepUs);
  expect(level.peaks.slice(0, (onset - 1) * 2).every((p) => p === 0)).toBe(
    true,
  );
  expect(
    level.peaks.slice((onset + 1) * 2).some((p) => Math.abs(p) > 0.4),
  ).toBe(true);
});
test("canvas leaves exact silence fully transparent and keeps the separate playhead", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const calls: { x: number; h: number }[] = [];
    Object.assign(window, { waveformBars: calls });
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
      calls.push({ x, h });
      return fill.call(this, x, y, w, h);
    };
  });
  await page.getByLabel("files").setInputFiles(join(dir, "source.wav"));
  await expect(
    page.getByText("音声波形の解析完了", { exact: true }),
  ).toBeVisible();
  const bars = await page.evaluate(
    () =>
      (window as unknown as { waveformBars: { x: number; h: number }[] })
        .waveformBars,
  );
  expect(bars.length).toBeGreaterThan(0);
  // 80 px/sec: the first second is exactly silent PCM; no minimum bars there.
  expect(bars.filter((b) => b.x >= 0 && b.x < 75)).toHaveLength(0);
  expect(bars.every((b) => b.h > 0)).toBe(true);
  const silentHasPixels = await page
    .getByLabel("音声波形", { exact: true })
    .evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      const ratio = canvas.height / 88;
      const data = canvas
        .getContext("2d")!
        .getImageData(
          0,
          0,
          Math.min(canvas.width, Math.floor(70 * ratio)),
          canvas.height,
        ).data;
      return data.some((value, i) => i % 4 === 3 && value > 0);
    });
  expect(silentHasPixels).toBe(false);
});
