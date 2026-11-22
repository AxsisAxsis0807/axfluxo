import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("device encoder joins trimmed audio/video or reports an unavailable encoder", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "local-encode-")),
    path = join(dir, "source.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=blue:size=320x180:rate=60:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-c:a",
    "aac",
    "-y",
    path,
  ]);
  const result = await build({
    entryPoints: [
      new URL("local-encode-fixture.tsx", import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
  });
  await page.route("https://encode.test/source.mp4", async (r) =>
    r.fulfill({ contentType: "video/mp4", body: await readFile(path) }),
  );
  await page.route("https://encode.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<html><div id="root"></div><script src="/bundle.js"></script></html>`,
    }),
  );
  await page.route("https://encode.test/bundle.js", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: result.outputFiles[0].text,
    }),
  );
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    let blocked = false;
    HTMLMediaElement.prototype.play = function () {
      if (!blocked) {
        blocked = true;
        return Promise.reject(
          new DOMException("tap required", "NotAllowedError"),
        );
      }
      return original.call(this);
    };
  });
  await page.goto("https://encode.test/");
  await expect(page.getByRole("checkbox")).toBeChecked();
  const available = await page.evaluate(
    () =>
      typeof MediaRecorder !== "undefined" &&
      [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp8,opus",
      ].some((type) => MediaRecorder.isTypeSupported(type)),
  );
  await page.getByRole("button", { name: "端末内で書き出す" }).click();
  if (!available) {
    // Linux WebKit may expose no encoder; native Safari has its own codec stack.
    await expect(page.getByRole("status")).toContainText(
      "このブラウザーは端末内エンコードに対応していません。",
    );
    await expect(page.getByRole("link", { name: /を保存/ })).toHaveCount(0);
    return;
  }
  await page
    .getByRole("button", { name: "再生を許可して書き出しを続ける" })
    .click();
  await page.getByRole("button", { name: /詳細を開く/ }).click();
  await expect(
    page.getByRole("dialog").getByText(/完了・保存できます/),
  ).toBeVisible({ timeout: 20000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: /を保存/ }).click();
  const download = await downloadPromise;
  const output = join(dir, download.suggestedFilename());
  await download.saveAs(output);
  const info = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", output],
      { encoding: "utf8" },
    ),
  );
  expect(
    info.streams.map((s: { codec_type: string }) => s.codec_type).sort(),
  ).toEqual(["audio", "video"]);
  // A declared audio stream is insufficient: the old muted source encoded silence.
  const pcm = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-i",
    output,
    "-vn",
    "-f",
    "f32le",
    "-ac",
    "1",
    "-ar",
    "8000",
    "pipe:1",
  ]);
  let energy = 0;
  for (let i = 0; i + 4 <= pcm.length; i += 4)
    energy += pcm.readFloatLE(i) ** 2;
  expect(Math.sqrt(energy / (pcm.length / 4))).toBeGreaterThan(0.005);
  expect(Number(info.format.duration)).toBeGreaterThan(0.8);
  expect(Number(info.format.duration)).toBeLessThan(2);
});


test("encoder records a real 1.5-second silent interval rather than pausing the output", async ({
  page,
}) => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), "local-encode-gap-")),
    path = join(dir, "source.mp4");
  execFileSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=blue:size=320x180:rate=60:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-threads", "1", "-c:a", "aac", "-y", path,
  ]);
  const built = await build({
    entryPoints: [new URL("local-encode-fixture.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
  });
  await page.route("https://encode.test/source.mp4", async (r) =>
    r.fulfill({ contentType: "video/mp4", body: await readFile(path) }),
  );
  await page.route("https://encode.test/?gap=1", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html><div id="root"></div><script src="/bundle.js"></script></html>',
    }),
  );
  await page.route("https://encode.test/bundle.js", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: built.outputFiles[0].text,
    }),
  );
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    let blocked = false;
    HTMLMediaElement.prototype.play = function () {
      if (!blocked) {
        blocked = true;
        return Promise.reject(new DOMException("tap required", "NotAllowedError"));
      }
      return original.call(this);
    };
  });
  await page.goto("https://encode.test/?gap=1");
  const available = await page.evaluate(
    () => typeof MediaRecorder !== "undefined" &&
      ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4",
        "video/webm;codecs=vp8,opus"].some((type) => MediaRecorder.isTypeSupported(type)),
  );
  await page.getByRole("button", { name: "端末内で書き出す" }).click();
  if (!available) {
    await expect(page.getByRole("status")).toContainText(
      "このブラウザーは端末内エンコードに対応していません。",
    );
    return;
  }
  await page.getByRole("button", { name: "再生を許可して書き出しを続ける" }).click();
  await page.getByRole("button", { name: /詳細を開く/ }).click();
  await expect(page.getByRole("dialog").getByText(/完了・保存できます/))
    .toBeVisible({ timeout: 30000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: /を保存/ }).click();
  const download = await downloadPromise,
    output = join(dir, download.suggestedFilename());
  await download.saveAs(output);
  const info = JSON.parse(execFileSync(
    "ffprobe", ["-v", "error", "-show_format", "-of", "json", output],
    { encoding: "utf8" },
  ));
  const duration = Number(info.format.duration);
  expect(duration).toBeGreaterThan(2.2);
  expect(duration).toBeLessThan(3.1);
  const pcm = execFileSync("ffmpeg", [
    "-v", "error", "-i", output, "-vn", "-f", "f32le",
    "-ac", "1", "-ar", "8000", "pipe:1",
  ]);
  const rms = (start: number, end: number) => {
    let energy = 0;
    const from = Math.floor(start * 8000), to = Math.floor(end * 8000);
    for (let n = from; n < to; n++)
      energy += pcm.readFloatLE(n * 4) ** 2;
    return Math.sqrt(energy / (to - from));
  };
  expect(pcm.length).toBeGreaterThan(2.2 * 8000 * 4);
  expect(rms(0.1, 0.3)).toBeGreaterThan(0.005);
  expect(rms(0.9, 1.3)).toBeLessThan(0.003);
  expect(rms(2.1, 2.3)).toBeGreaterThan(0.005);
});
