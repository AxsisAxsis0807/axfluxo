import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { audioMetadataTimeoutMs } from "../../../src/services/video/local-audio";

const formats = [
  ["mp3", "audio/mpeg", "libmp3lame"],
  ["wav", "audio/wav", "pcm_s16le"],
  ["m4a", "audio/mp4", "aac"],
  ["aac", "audio/aac", "aac"],
  ["flac", "audio/flac", "flac"],
  ["ogg", "audio/ogg", "libvorbis"],
] as const;
let dir: string;
let bundle: string;
test.setTimeout(120_000);
test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "axfluxo-direct-audio-"));
  for (const [index, [extension, , codec]] of formats.entries())
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${330 + index * 55}:sample_rate=44100:duration=1.6`,
      "-ac",
      "1",
      "-c:a",
      codec,
      "-y",
      join(dir, `sample.${extension}`),
    ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=blue:s=16x16",
    "-frames:v",
    "1",
    "-threads",
    "1",
    "-y",
    join(dir, "cover.png"),
  ]);
  const result = await build({
    entryPoints: [new URL("recovery-fixture.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
  });
  bundle = result.outputFiles[0].text;
});

async function open(page: Page, mode: string) {
  await page.route(/^https?:\/\//, (route) => {
    if (
      route.request().url() !== `https://direct-audio.test/${mode}` ||
      !route.request().isNavigationRequest()
    )
      return route.abort();
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><div id="root"></div><script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>`,
    });
  });
  await page.goto(`https://direct-audio.test/${mode}`);
  await expect(
    page.getByLabel("音声ファイルを選択", { exact: true }),
  ).toBeEnabled();
}
async function exportAndDecode(page: Page) {
  const canRecord = await page.evaluate(
    () =>
      typeof MediaRecorder !== "undefined" &&
      typeof HTMLCanvasElement.prototype.captureStream === "function" &&
      [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp8,opus",
      ].some((type) => MediaRecorder.isTypeSupported(type)),
  );
  await page
    .getByRole("button", { name: "端末内で書き出す", exact: true })
    .click();
  if (!canRecord) {
    await expect(
      page
        .getByRole("region", { name: "端末内書き出し", exact: true })
        .getByRole("status"),
    ).toContainText(
      /端末内エンコードに対応していません|Canvasの動画書き出しに対応していません/,
    );
    await expect(
      page.getByRole("link", { name: /\.(mp4|webm)を保存$/ }),
    ).toHaveCount(0);
    return null;
  }
  await page.getByRole("button", { name: /詳細を開く/ }).click();
  const dialog = page.getByRole("dialog", { name: "エクスポート管理" });
  const permit = dialog.getByRole("button", {
    name: "音声処理を許可・キューを再開",
  });
  if (await permit.isVisible()) await permit.click();
  const link = dialog.getByRole("link", { name: /\.(mp4|webm)を保存$/ });
  await expect(link).toBeVisible({ timeout: 50000 });
  const download = page.waitForEvent("download");
  await link.click();
  const saved = await download;
  const path = join(dir, saved.suggestedFilename());
  await saved.saveAs(path);
  const tracks = JSON.parse(
    execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type,time_base",
      "-of", "json", path,
    ], { encoding: "utf8" }),
  ).streams as { codec_type: string; time_base: string }[];
  const video = tracks.find((track) => track.codec_type === "video");
  expect(video).toBeDefined();
  const decoded = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-xerror",
    "-i",
    path,
    "-map",
    "0:v",
    "-map",
    "0:a",
    "-fps_mode",
    "passthrough",
    "-enc_time_base:v",
    video!.time_base,
    "-f",
    "null",
    "-",
  ], { encoding: "utf8" });
  expect(decoded.error).toBeUndefined();
  expect(decoded.status, decoded.stderr).toBe(0);
  expect(decoded.stderr).toBe("");
  return path;
}

test("corrupt MP3, WAV and M4A leave the picker ready for another file", async ({
  page,
}) => {
  await open(page, "all-versions");
  const picker = page.getByLabel("音声ファイルを選択", { exact: true });
  for (const [name, mimeType] of [
    ["broken.mp3", "audio/mpeg"],
    ["broken.wav", "audio/wav"],
    ["broken.m4a", "audio/mp4"],
  ]) {
    await picker.setInputFiles({
      name,
      mimeType,
      buffer: Buffer.from("invalid media"),
    });
    await expect(page.getByRole("alert")).toContainText(
      "音声形式を再生できない",
    );
    await expect(picker).toBeEnabled();
    await expect(page.locator("legend").filter({ hasText: name })).toHaveCount(
      0,
    );
  }
  await picker.setInputFiles(join(dir, "sample.wav"));
  await expect(
    page.locator("legend").filter({ hasText: "sample.wav" }),
  ).toBeVisible();
});

test("All Versions plays supported audio formats, restores order and exports the selected versions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "all-versions");
  const picker = page.getByLabel("音声ファイルを選択", { exact: true });
  await picker.setInputFiles({
    name: "空.wav", mimeType: "audio/wav", buffer: Buffer.alloc(0),
  });
  await expect(page.getByRole("alert")).toContainText("音声ファイルが空です");
  await expect(picker).toBeEnabled();
  let supported = 0;
  for (const [extension, mimeType] of formats) {
    const name = `sample.${extension}`;
    await picker.setInputFiles({
      name,
      mimeType,
      buffer: await readFile(join(dir, name)),
    });
    // Raw AAC can remain durationless in WebKit until the application's limit.
    await expect(picker).toBeEnabled(
      extension === "aac" ? { timeout: audioMetadataTimeoutMs + 1_000 } : {},
    );
    const item = page
      .locator("fieldset")
      .filter({ has: page.locator("legend").filter({ hasText: name }) });
    if (await item.count()) {
      supported++;
      await expect(item.getByText(/44100 Hz · 1 ch/)).toBeVisible();
      const media = item.locator("audio");
      await media.evaluate(async (el: HTMLAudioElement) => {
        await el.play();
        el.pause();
      });
    } else {
      await expect(
        page.getByRole("alert").filter({
          hasText:
            extension === "aac"
              ? /音声形式を再生できない|音声ファイルの再生時間を取得できません|音声の読み込みがタイムアウトしました/
              : /音声形式を再生できない|音声ファイルの再生時間を取得できません/,
        }),
      ).toBeVisible();
    }
  }
  expect(supported).toBeGreaterThanOrEqual(2);
  const versions = page.getByLabel("バージョン名", { exact: true });
  await versions.nth(0).fill("元音声");
  await versions.nth(1).fill("Versão lenta");
  const rows = page
    .locator("fieldset")
    .filter({ has: page.getByLabel("バージョン名", { exact: true }) });
  const firstId = await rows.nth(0).locator("audio").getAttribute("id");
  const secondId = await rows.nth(1).locator("audio").getAttribute("id");
  await page
    .getByRole("button", { name: "バージョンを上へ", exact: true })
    .nth(1)
    .click();
  await expect(versions.first()).toHaveValue("Versão lenta");
  await page
    .getByLabel("このバージョンの音声を差し替え")
    .first()
    .setInputFiles({
      name: "差替.wav",
      mimeType: "audio/wav",
      buffer: await readFile(join(dir, "sample.wav")),
    });
  await expect(page.getByText(/差替\.wav/).first()).toBeVisible();
  await expect(rows.nth(0).locator("audio")).toHaveAttribute("id", secondId!);
  await expect(rows.nth(1).locator("audio")).toHaveAttribute("id", firstId!);
  await expect(versions.first()).toHaveValue("Versão lenta");
  await expect(versions.nth(1)).toHaveValue("元音声");
  await page.getByLabel("カバー画像").setInputFiles(join(dir, "cover.png"));
  await expect(page.getByTestId("local-save-status")).toContainText(
    "この端末に自動保存済み",
    { timeout: 30000 },
  );
  await page.reload();
  await expect(versions.first()).toHaveValue("Versão lenta", {
    timeout: 35000,
  });
  await expect(versions.nth(1)).toHaveValue("元音声");
  await expect(page.getByText(/差替\.wav/).first()).toBeVisible();
  await page.getByRole("button", { name: "合成プレビューを更新" }).click();
  const preview = page.getByRole("region", { name: "合成プレビュー" });
  await expect(
    preview.getByLabel("プレビューする素材").locator("option").first(),
  ).toHaveText("Versão lenta");
  await expect(preview.locator("audio")).toHaveAttribute("src", /^blob:/);
  await preview
    .locator("audio")
    .evaluate((element: HTMLAudioElement) => element.play());
  await expect(preview.getByLabel("プレビューする素材")).toHaveValue("1");
  await preview
    .locator("audio")
    .evaluate((element: HTMLAudioElement) => element.pause());
  await exportAndDecode(page);
  await rows.first().getByRole("button", { name: "素材を外す" }).click();
  await expect(preview).toHaveCount(0);
  await expect(versions.first()).toHaveValue("元音声");
  await expect(rows.first().locator("audio")).toHaveAttribute("id", firstId!);
  await expect(page.locator(`audio[id="${secondId}"]`)).toHaveCount(0);
});

test("FNF Showcase renders a synchronized range directly from audio", async ({
  page,
}) => {
  await open(page, "fnf-showcase");
  const picker = page.getByLabel("音声ファイルを選択", { exact: true });
  await picker.setInputFiles({
    name: "破損.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("invalid"),
  });
  await expect(page.getByRole("alert")).toContainText("音声形式を再生できない");
  await picker.setInputFiles({
    name: "拡張子が異なる.mp3",
    mimeType: "audio/mpeg",
    buffer: await readFile(join(dir, "sample.wav")),
  });
  await expect(picker).toBeEnabled();
  if (await page.getByText(/44100 Hz · 1 ch/).count()) {
    await expect(page.getByRole("alert")).toHaveCount(0);
  } else {
    await expect(page.getByRole("alert")).toContainText("音声形式を再生できない");
  }
  await picker.setInputFiles(join(dir, "sample.wav"));
  await expect(
    page.locator("legend").filter({ hasText: "sample.wav" }),
  ).toBeVisible();
  await expect(page.getByText(/44100 Hz · 1 ch/)).toBeVisible();
  await page.getByLabel("譜面名").fill("音声テスト");
  await page.getByLabel("開始秒", { exact: true }).fill("0.2");
  await page.getByLabel("終了秒", { exact: true }).fill("1.4");
  await page.getByRole("button", { name: "合成プレビューを更新" }).click();
  const preview = page.getByRole("region", { name: "合成プレビュー" });
  await expect(
    preview.getByLabel("プレビューする素材").locator("option").first(),
  ).toHaveText("音声テスト");
  const audio = preview.locator("audio");
  await expect(audio).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() => audio.evaluate((media: HTMLAudioElement) => media.currentTime))
    .toBeCloseTo(0.2, 1);
  await exportAndDecode(page);
});

test("stereo 48 kHz export preserves audio at the start, middle and end", async ({ page }) => {
  const fixture = join(dir, "three-tones.wav");
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i",
    "aevalsrc=0.25*sin(2*PI*(330*t+220*max(t-8\\,0)+220*max(t-16\\,0)))|0.2*sin(2*PI*250*t):s=48000:d=24",
    "-c:a", "pcm_s16le", "-y", fixture,
  ]);
  await open(page, "fnf-showcase");
  await page.getByLabel("音声ファイルを選択", { exact: true }).setInputFiles(fixture);
  await expect(page.getByText(/48000 Hz · 2 ch/)).toBeVisible();
  await page.getByLabel("譜面名").fill("Three tones");
  await page.getByLabel("開始秒", { exact: true }).fill("0.5");
  await page.getByLabel("終了秒", { exact: true }).fill("23.5");
  const path = await exportAndDecode(page);
  if (!path) return;
  const tracks = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,start_time,duration",
    "-of", "json", path,
  ], { encoding: "utf8" })).streams as { codec_type: string; start_time?: string; duration?: string }[];
  const [video, audio] = ["video", "audio"].map((kind) =>
    tracks.find((track) => track.codec_type === kind)!,
  );
  expect(Math.abs(Number(video.start_time) - Number(audio.start_time))).toBeLessThan(0.25);
  if (video.duration && audio.duration) {
    expect(Math.abs(Number(video.duration) - Number(audio.duration))).toBeLessThan(0.35);
    expect(Math.abs(Number(audio.duration) - 23)).toBeLessThan(0.5);
  }
  for (const [position, frequency] of [[0.25, 330], [11, 550], [22.45, 770]]) {
    const pcm = execFileSync("ffmpeg", [
      "-v", "error", "-ss", String(position), "-i", path,
      "-map", "0:a:0", "-af",
      "pan=mono|c0=c0,aresample=8000,atrim=end_sample=1600",
      "-f", "s16le", "-",
    ]);
    expect(pcm.length).toBe(3200);
    let crossings = 0;
    for (let offset = 2; offset < pcm.length; offset += 2) {
      if (pcm.readInt16LE(offset - 2) < 0 && pcm.readInt16LE(offset) >= 0)
        crossings++;
    }
    expect(Math.abs(crossings / 0.2 - frequency)).toBeLessThan(25);
  }
});
