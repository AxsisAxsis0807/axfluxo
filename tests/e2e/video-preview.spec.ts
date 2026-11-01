import { test, expect } from "@playwright/test";
test("preview rollback flag leaves Studio and existing databases alone", async ({
  page,
}) => {
  await page.goto("developer/preview/");
  await expect(
    page.getByRole("heading", { name: "動画preview・非破壊trim" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("入口は無効");
  await expect(page.locator("video")).toHaveCount(0);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
});

test("cloud library starts with no API connection or automatic legacy-image migration", async ({
  page,
}) => {
  await page.goto("developer/library/");
  await expect(
    page.getByRole("heading", { name: "開発者クラウド素材" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("APIは未設定");
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
});
