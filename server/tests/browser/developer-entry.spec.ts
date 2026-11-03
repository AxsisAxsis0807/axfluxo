import { test, expect } from "@playwright/test";
import { build } from "esbuild";
test.setTimeout(60_000);
let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [
      new URL("developer-entry-fixture.tsx", import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env": "{}",
      "process.env.NODE_ENV": '"test"',
      "process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN": '"https://entry-api.test"',
      "process.env.NEXT_PUBLIC_BASE_PATH": '""',
    },
    plugins: [
      {
        name: "session",
        setup(b) {
          b.onLoad({ filter: /\/services\/auth\.ts$/ }, () => ({
            loader: "ts",
            contents: `
      const auth = { getSession: async () => ({ data: {session: {access_token: "test", expires_at: 9999999999, user: {id: "11111111-1111-4111-8111-111111111111"}}},error: null}), onAuthStateChange: () => ({data: {subscription: {unsubscribe(){}}}}) };
      export const authClient = () => ({auth}); export const authError = () => "error"; export const authRedirect = () => "/";`,
          }));
        },
      },
    ],
  });
  bundle = result.outputFiles[0].text;
});
for (const allowed of [true, false])
  test(`developer entry and direct routes: membership=${allowed}`, async ({
    page,
  }) => {
    let permitted = allowed;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("https://entry-api.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
      };
      if (route.request().method() === "OPTIONS")
        return route.fulfill({ status: 204, headers });
      const body =
        path === "/v1/developer/me"
          ? permitted
            ? {
                ownerId: "11111111-1111-4111-8111-111111111111",
                membership: "developer",
              }
            : { code: "DEVELOPER_REQUIRED" }
          : path === "/outputs"
            ? { items: [], nextCursor: null }
            : {};
      return route.fulfill({
        status: !permitted ? 403 : 200,
        headers,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
    await page.route("https://entry.test/bundle.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: bundle }),
    );
    await page.route("https://entry.test/**", (route) =>
      new URL(route.request().url()).pathname === "/bundle.js"
        ? route.fulfill({ contentType: "application/javascript", body: bundle })
        : route.fulfill({
            contentType: "text/html",
            body: `<html lang="ja"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/bundle.js"></script></html>`,
          }),
    );
    await page.goto("https://entry.test/");
    const entry = page.getByRole("link", {
      name: "Developer Studio",
      exact: true,
    });
    if (allowed) {
      await expect(entry).toBeVisible({ timeout: 15_000 });
      await entry.click();
      await expect(
        page.getByRole("heading", { name: "Developer Studio", exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      await page
        .getByRole("link", { name: "All Versions Video Maker", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "All Versions Video Maker",
          exact: true,
        }),
      ).toBeVisible({ timeout: 15_000 });
      await page.goto("https://entry.test/developer/studio/");
      await page
        .getByRole("link", { name: "FNF Showcase Maker", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "FNF Showcase Maker", exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      permitted = false;
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await expect(page.getByRole("status")).toContainText(
        "開発者権限を確認できません",
      );
      await expect(page.getByRole("heading")).toHaveCount(0);
    } else {
      await expect(entry).toHaveCount(0);
      for (const path of ["studio", "all-versions", "fnf-showcase"]) {
        await page.goto(`https://entry.test/developer/${path}/`);
        await expect(page.getByRole("status")).toContainText(
          "開発者権限を確認できません",
        );
        await expect(page.getByRole("heading")).toHaveCount(0);
      }
    }
    expect(errors).toEqual([]);
  });
