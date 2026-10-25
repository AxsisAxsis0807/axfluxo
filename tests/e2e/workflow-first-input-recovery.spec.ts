import { expect, test } from "@playwright/test";
test("an independent duplicate can explicitly resume its frozen image when disconnected", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("button", { name: "＋ 画像編集", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "画像編集ノード詳細" });
  const bytes = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    c.getContext("2d")!.fillRect(0, 0, 64, 64);
    return [
      ...Uint8Array.from(atob(c.toDataURL().split(",")[1]), (v) =>
        v.charCodeAt(0),
      ),
    ];
  });
  await page
    .locator(
      '.workflow-first input[type=file][accept="image/png,image/jpeg,image/webp"]',
    )
    .setInputFiles({
      name: "frozen.png",
      mimeType: "image/png",
      buffer: Buffer.from(bytes),
    });
  await expect(panel.getByLabel("入力方法", { exact: true })).toHaveValue(
    "selected",
  );
  await panel
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "複製", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await panel.getByLabel("ノード設定を閉じる", { exact: true }).click();
  await page
    .locator(".react-flow__node")
    .last()
    .getByRole("button", { name: "画像編集の設定", exact: true })
    .click();
  await panel.getByLabel("入力方法", { exact: true }).selectOption("connected");
  await panel
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  const choice = page.getByRole("dialog", { name: "入力変更の選択" });
  await expect(choice).toBeVisible();
  await expect(choice.getByRole("alert")).toContainText("接続されていません");
  await expect(
    choice.getByRole("button", {
      name: "コピー後に入力レイヤーのみ差し替え",
      exact: true,
    }),
  ).toBeDisabled();
  await choice
    .getByRole("button", { name: "現在の固定入力を維持", exact: true })
    .click();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("レイヤーを表示", { exact: true }).click();
  await expect(page.locator(".layer-row")).toHaveCount(1);
  const close = page.getByLabel("設定を閉じる", { exact: true });
  if (await close.isVisible()) await close.click();
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(panel).toBeVisible();
});
