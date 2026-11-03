import { test, expect } from "@playwright/test";
test("entry, device setup, incorrect input, reload, both tools and manual relock work without APIs", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (r) => {
    if (/supabase|\/v1\/developer/.test(r.url())) remote.push(r.url());
  });
  await page.goto("./");
  await expect(
    page.getByRole("link", { name: "Developer Studio", exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Developer Studio", exact: true })
    .first()
    .click();
  await page
    .getByLabel("パスコード", { exact: true })
    .fill("test-only-passcode");
  await page
    .getByLabel("パスコードの確認", { exact: true })
    .fill("test-only-passcode");
  await page.getByRole("button", { name: "設定してロック解除" }).click();
  await expect(
    page.getByRole("heading", { name: "Developer Studio", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "再ロック", exact: true }).click();
  await page.getByLabel("パスコード", { exact: true }).fill("incorrect");
  await page.getByRole("button", { name: "ロック解除", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("違います");
  await page.getByLabel("入力を表示").check();
  await expect(page.getByLabel("パスコード", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await page
    .getByLabel("パスコード", { exact: true })
    .fill("test-only-passcode");
  await page.getByRole("button", { name: "ロック解除", exact: true }).click();
  await page.reload();
  for (const name of ["All Versions Video Maker", "FNF Showcase Maker"]) {
    await page.getByRole("link", { name, exact: true }).click();
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("端末の素材", { exact: true })).toBeVisible();
    await page
      .getByRole("link", { name: "Developer Studioへ戻る", exact: true })
      .click();
  }
  await page.evaluate(() =>
    sessionStorage.setItem(
      "axfluxo.developer.local-unlock.v1",
      String(Date.now() - 1),
    ),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Developer Studio 簡易ロック" }),
  ).toBeVisible();
  expect(remote).toEqual([]);
});
