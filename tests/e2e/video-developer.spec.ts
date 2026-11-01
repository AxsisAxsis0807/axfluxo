import { test, expect } from "@playwright/test";
test("static developer diagnostics stay on hold without API configuration", async ({
  page,
  baseURL,
}) => {
  const errors: string[] = [],
    apiRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      /\/(v1\/developer\/me|render-batches|render-jobs)(\/|$)/.test(
        new URL(request.url()).pathname,
      )
    )
      apiRequests.push(request.url());
  });
  await page.goto("developer/video/");
  await expect(
    page.getByRole("heading", { name: "開発者用動画ジョブ" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("保留中");
  await expect(
    page.getByText("開発者APIは未設定です。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "制作画面・ログインへ戻る" }),
  ).toHaveAttribute(
    "href",
    new URL(baseURL!).pathname.replace(/\/$/, "") || "/",
  );
  await expect(
    page.getByRole("button", { name: "ジョブの状態を確認" }),
  ).toHaveCount(0);
  expect(apiRequests).toEqual([]);
  expect(errors).toEqual([]);
});
