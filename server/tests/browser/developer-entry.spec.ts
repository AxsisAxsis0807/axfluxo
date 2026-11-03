import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      "process.env.NEXT_PUBLIC_BASE_PATH": '""',
    },
    plugins: [
      {
        name: "session",
        setup(b) {
          b.onLoad({ filter: /\/services\/auth\.ts$/ }, () => ({
            loader: "ts",
            contents: `
      const auth = { getSession: async () => ({ data: {session: {access_token: "test", expires_at: 9999999999, user_metadata: {role:"developer"}, user: {id: "11111111-1111-4111-8111-111111111111"}}},error: null}), onAuthStateChange: () => ({data: {subscription: {unsubscribe(){}}}}) };
      export const authClient = () => ({auth, rpc: async () => { const r=await fetch("https://entry-api.test/access",{method:"POST"}); return {data:await r.json(),error: r.ok ? null : {code:"RPC_FAILED"}}; }}); export const authError = () => "error"; export const authRedirect = () => "/";`,
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
        path === "/access"
          ? permitted
            ? {
                ownerId: "11111111-1111-4111-8111-111111111111",
                membership: "developer",
                validUntil: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
          : path === "/outputs"
            ? { items: [], nextCursor: null }
            : {};
      return route.fulfill({
        status: 200,
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

for (const mode of ["all-versions", "fnf-showcase"] as const)
  test(`local ${mode} accepts device files and exports without video API`, async ({
    page,
  }) => {
    const dir = await mkdtemp(join(tmpdir(), "local-tool-")),
      file = join(dir, "source.mp4"),
      cover = join(dir, "cover.png");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:size=160x90:rate=30:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-c:a",
      "aac",
      "-y",
      file,
    ]);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:size=16x16",
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-y",
      cover,
    ]);
    const unexpected: string[] = [];
    page.on("request", (r) => {
      if (
        !r.url().startsWith("https://entry.test/") &&
        !r.url().startsWith("blob:") &&
        !r.url().startsWith("https://entry-api.test/access")
      )
        unexpected.push(r.url());
    });
    await page.route("https://entry-api.test/access", (r) =>
      r.fulfill({
        headers: { "access-control-allow-origin": "*" },
        contentType: "application/json",
        body: JSON.stringify({
          ownerId: "11111111-1111-4111-8111-111111111111",
          membership: "developer",
          validUntil: new Date(Date.now() + 60000).toISOString(),
        }),
      }),
    );
    await page.route("https://entry.test/**", (r) =>
      r.fulfill(
        new URL(r.request().url()).pathname === "/bundle.js"
          ? { contentType: "application/javascript", body: bundle }
          : {
              contentType: "text/html",
              body: '<html><div id="root"></div><script src="/bundle.js"></script></html>',
            },
      ),
    );
    await page.goto(`https://entry.test/developer/${mode}/`);
    await page
      .getByLabel("端末の素材", { exact: true })
      .setInputFiles({
        name: "source.mp4",
        mimeType: "video/mp4",
        buffer: await readFile(file),
      });
    await expect(
      page.getByRole("button", { name: "端末内で書き出す" }),
    ).toBeEnabled();
    if (mode === "all-versions") {
      await page
        .getByLabel("カバー画像")
        .setInputFiles({
          name: "cover.png",
          mimeType: "image/png",
          buffer: await readFile(cover),
        });
      await page.getByLabel("version名（1行に1つ）").fill("local version");
    } else await page.getByLabel("譜面名", { exact: true }).fill("local chart");
    const available = await page.evaluate(
      () =>
        typeof MediaRecorder !== "undefined" &&
        [
          "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
          "video/mp4",
          "video/webm;codecs=vp8,opus",
        ].some((t) => MediaRecorder.isTypeSupported(t)),
    );
    await page.getByRole("button", { name: "端末内で書き出す" }).click();
    if (available) {
      await expect(page.getByRole("status")).toContainText("完了", {
        timeout: 20000,
      });
      await expect(page.getByRole("link", { name: /を保存/ })).toHaveCount(1);
    } else
      await expect(page.getByRole("status")).toContainText("対応していません");
    expect(unexpected).toEqual([]);
  });
