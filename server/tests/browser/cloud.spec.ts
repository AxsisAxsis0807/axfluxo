import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let bundle: string;
test.beforeAll(async () => {
  const r = await build({
    entryPoints: [new URL("cloud-fixture.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"test"' },
  });
  bundle = r.outputFiles[0].text;
});
test("background pause, tab reload and explicit file reselection preserve upload safely", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://cloud-browser.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ja"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://cloud-browser.test/");
  await page.addScriptTag({ content: bundle });
  const input = page.getByLabel("クラウドへ転送する素材");
  await expect(input).toBeEnabled();
  await input.setInputFiles({
    name: "same.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("original"),
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { storagePutStarted?: boolean })
            .storagePutStarted,
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("alert")).toContainText("一時停止");
  expect(
    await page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([k]) => k.startsWith("axfluxo-cloud-upload-v1:"))
        .map(([, v]) => v)
        .join(),
    ),
  ).not.toMatch(/https:|private-test-token|Bearer/);
  await page.reload();
  await page.addScriptTag({ content: bundle });
  await expect(input).toBeEnabled();
  expect(await input.inputValue()).toBe("");
  await page
    .getByRole("button", { name: "同じファイルを再選択して再開" })
    .click();
  await input.setInputFiles({
    name: "same.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("replaced"),
  });
  await expect(page.getByRole("alert")).toContainText("一致しません");
  await page.evaluate(() => sessionStorage.setItem("allow-upload", "true"));
  await page
    .getByRole("button", { name: "同じファイルを再選択して再開" })
    .click();
  await input.setInputFiles({
    name: "same.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("original"),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "verifying" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
