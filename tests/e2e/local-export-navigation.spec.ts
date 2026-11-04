import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("local export survives Studio navigation and switching tools", async ({
  page,
}) => {
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
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(file);
  await page.getByLabel("譜面名", { exact: true }).fill("NAVIGATION");
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
  await expect(
    page
      .getByRole("dialog", { name: "エクスポート管理" })
      .getByRole("link", { name: "NAVIGATION.mp4を保存", exact: true }),
  ).toBeVisible({ timeout: 20000 });
});
