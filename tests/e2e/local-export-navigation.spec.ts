import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("local export survives Studio navigation and switching tools", async ({
  page,
  browser,
}, testInfo) => {
  const codecs = await page.evaluate(() => ({
    video: document
      .createElement("video")
      .canPlayType('video/mp4; codecs="avc1.42E01E"'),
    audio: document
      .createElement("audio")
      .canPlayType('audio/mp4; codecs="mp4a.40.2"'),
  }));
  expect(
    codecs.video,
    `${browser.version()}: H.264 decoder required for the MP4 fixture`,
  ).not.toBe("");
  expect(
    codecs.audio,
    `${browser.version()}: AAC decoder required for the MP4 fixture`,
  ).not.toBe("");
  const directory = await mkdtemp(join(tmpdir(), "queue-navigation-"));
  const file = join(directory, "source.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=blue:size=160x90:rate=30:duration=8",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=8",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-c:a",
    "aac",
    "-y",
    file,
  ]);
  await page.goto("./developer/studio/");
  await page
    .getByLabel("パスコード", { exact: true })
    .fill("test-passcode-123");
  await page
    .getByLabel("パスコードの確認", { exact: true })
    .fill("test-passcode-123");
  await page
    .getByRole("button", { name: "設定してロック解除", exact: true })
    .click();
  await page
    .getByRole("link", { name: "FNF Showcase Maker", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "FNF Showcase Maker", exact: true }),
  ).toBeVisible();
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(file);
  await expect(
    page.getByRole("group", { name: /^素材 1：source\.mp4/ }),
  ).toBeVisible();
  await page.getByLabel("譜面名", { exact: true }).fill("NAVIGATION");
  await page.getByLabel("開始秒", { exact: true }).fill("1");
  await page.getByLabel("終了秒", { exact: true }).fill("4");
  await page
    .getByRole("button", { name: "端末内で書き出す", exact: true })
    .click();
  const dock = page.getByRole("complementary", {
    name: "エクスポートミニバー",
  });
  await expect(dock).toContainText("NAVIGATION.mp4");
  await page
    .getByRole("link", { name: "Developer Studioへ戻る", exact: true })
    .click();
  await expect(dock).toContainText("NAVIGATION.mp4");
  await page
    .getByRole("link", { name: "All Versions Video Maker", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "All Versions Video Maker",
      exact: true,
    }),
  ).toBeVisible();
  await expect(dock).toContainText("NAVIGATION.mp4");
  await dock.getByRole("button", { name: /詳細を開く/ }).click();
  const save = page
    .getByRole("dialog", { name: "エクスポート管理" })
    .getByRole("link", { name: "NAVIGATION.mp4を保存", exact: true });
  await expect(save).toBeVisible({ timeout: 20000 });
  const downloaded = page.waitForEvent("download");
  await save.click();
  const output = await downloaded;
  await output.saveAs(testInfo.outputPath("NAVIGATION.mp4"));
  expect(await output.failure()).toBeNull();
});
