import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import type { RecoverableLocalJob } from "../../../src/services/video/cloud-local-job";

type Description = Pick<RecoverableLocalJob, "filename" | "width" | "height"> & {
  checksum: string; pieces: { start: number; end: number }[]; url: string;
};
type Fixture = { reserveCloudFixture(): Promise<Description[]>; restoreCloudFixture(): Promise<Description[]> };
let bundle: string;
test.beforeAll(async () => {
  bundle = (await build({
    entryPoints: [new URL("cloud-local-recovery-fixture.ts", import.meta.url).pathname],
    bundle: true, write: false, platform: "browser", format: "iife",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"test"' },
  })).outputFiles[0].text;
});
test("cloud reservations survive reload and rebuild both layouts and FNF ranges with fresh access", async ({ page }) => {
  test.setTimeout(120_000);
  const origin = "https://cloud-recovery.test";
  await page.route(origin + "/**", route => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html><body></body></html>",
  }));
  await page.route(origin + "/cover.png?*", route => route.fulfill({
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  }));
  for (const font of ["Aleo.ttf", "ReferenceClock.ttf"])
    await page.route(origin + "/fonts/" + font, route => route.fulfill({ path: "public/fonts/" + font, contentType: "font/ttf" }));
  await page.goto(origin);
  await page.addScriptTag({ content: bundle });
  const before = await page.evaluate(() => (window as unknown as Fixture).reserveCloudFixture());
  expect(before).toHaveLength(4);
  expect(before.map(x => x.height)).toEqual([1080, 1440, 1920, 1920]);
  expect(before.map(x => x.filename)).toEqual(["All Versions.mp4", "All Versions.mp4", "FIRST.mp4", "SECOND.mp4"]);
  await page.reload();
  await page.addScriptTag({ content: bundle });
  const after = await page.evaluate(() => (window as unknown as Fixture).restoreCloudFixture());
  expect(after.map(({ url, ...value }) => ({ ...value, url: url.replace("after", "before") }))).toEqual(before);
  expect(after.every(x => x.url.endsWith("generation=after"))).toBe(true);
});
