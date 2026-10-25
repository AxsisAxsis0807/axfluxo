import { expect, test } from "@playwright/test";
test("invalid variable forms remain uncommitted and can be cancelled or corrected", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("button", { name: "＋ 画像編集", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "画像編集ノード詳細" });
  await panel.getByLabel("入力方法", { exact: true }).selectOption("blank");
  await panel
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  const property = page.getByLabel("プロパティを表示", { exact: true });
  if (await property.isVisible()) await property.click();
  await page.getByRole("button", { name: "変数", exact: true }).click();
  const form = page.locator(".variable-form");
  await form.getByLabel("キー", { exact: true }).fill("__proto__");
  await form.getByLabel("表示名", { exact: true }).fill("未確定");
  await form.getByRole("button", { name: "変数を追加", exact: true }).click();
  await expect(page.locator(".session-bar").getByRole("status")).toHaveText(
    "入力未確定・未保存",
  );
  await expect(form.getByLabel("キー", { exact: true })).toHaveValue(
    "__proto__",
  );
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
  await form
    .getByRole("button", { name: "変数フォームを取り消す", exact: true })
    .click();
  await expect(page.locator(".session-bar").getByRole("status")).toHaveText(
    "保存済み",
  );
  await form.getByLabel("キー", { exact: true }).fill("title");
  await form.getByLabel("表示名", { exact: true }).fill("タイトル");
  await form.getByRole("button", { name: "変数を追加", exact: true }).click();
  await expect(page.locator(".variable-card")).toHaveCount(1);
  await expect(page.locator(".session-bar").getByRole("status")).toHaveText(
    "保存済み",
  );
  const close = page.getByLabel("設定を閉じる", { exact: true });
  if (await close.isVisible()) await close.click();
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(panel).toBeVisible();
});
