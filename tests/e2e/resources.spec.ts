import { test, expect } from "@playwright/test";

test("page, CSS, scripts and bundled fonts load without browser errors", async ({ page }) => {
  const errors: string[] = [];
  const failed: string[] = [];
  const loaded = new Set<string>();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => failed.push(request.url()));
  page.on("response", (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
    if (response.ok()) loaded.add(response.request().resourceType());
  });
  const response = await page.goto("./");
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "次のアイデアを、ここから。" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => loaded.has("font")).toBe(true);
  expect(loaded.has("stylesheet")).toBe(true);
  expect(loaded.has("script")).toBe(true);
  expect(errors).toEqual([]);
  expect(failed).toEqual([]);
});
