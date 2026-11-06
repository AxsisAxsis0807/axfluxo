import { test, expect } from "@playwright/test";
test("published worker detects local PCM and creates a Version boundary without numeric input", async ({
  page,
}) => {
  const rate = 8000,
    count = 42 * rate,
    pcm = Buffer.alloc(44 + count * 2);
  pcm.write("RIFF", 0);
  pcm.writeUInt32LE(pcm.length - 8, 4);
  pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(rate, 24);
  pcm.writeUInt32LE(rate * 2, 28);
  pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36);
  pcm.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const t = i / rate;
    pcm.writeInt16LE(
      t >= 20 && t < 21
        ? 0
        : Math.round(16000 * Math.sin(t * 2 * Math.PI * (t < 20 ? 220 : 1400))),
      44 + i * 2,
    );
  }
  await page.goto("./developer/studio/");
  await page
    .getByLabel("パスコード", { exact: true })
    .fill("boundary-test-passcode");
  await page
    .getByLabel("パスコードの確認", { exact: true })
    .fill("boundary-test-passcode");
  await page
    .getByRole("button", { name: "設定してロック解除", exact: true })
    .click();
  await page
    .getByRole("link", { name: "All Versions Video Maker", exact: true })
    .click();
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled();
  await page
    .getByLabel("端末の素材", { exact: true })
    .setInputFiles({
      name: "two-tracks.wav",
      mimeType: "audio/wav",
      buffer: pcm,
    });
  await page
    .getByRole("button", { name: "曲間を自動検出", exact: true })
    .click();
  const smart = page.getByRole("region", {
    name: "Smart Track Boundary Detection",
  });
  await expect(smart).toContainText("1件。", { timeout: 30000 });
  await expect(smart.locator("li")).toContainText("高信頼度");
  await smart.getByRole("button", { name: "移動", exact: true }).click();
  await page
    .getByRole("button", { name: "中央にVersion境界追加", exact: true })
    .click();
  const field = page.getByLabel("version境界（素材内の秒、カンマ区切り）");
  await expect(field).toHaveValue("20.5");
  await smart.getByLabel("推奨位置").selectOption("start");
  await smart
    .getByRole("button", { name: "境界として適用", exact: true })
    .click();
  await expect(field).toHaveValue("20");
});
