import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
let bundle: string, video: Buffer, thumbnail: Buffer;
test.beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "axfluxo-preview-ui-")),
    path = join(dir, "video.mp4"),
    image = join(dir, "thumb.jpg");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=60:duration=3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-y",
      path,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", path, "-frames:v", "1", "-y", image],
    { stdio: "ignore" },
  );
  video = await readFile(path);
  thumbnail = await readFile(image);
  const result = await build({
    entryPoints: [new URL("preview-fixture.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"test"' },
  });
  bundle = result.outputFiles[0].text;
});
async function open(page: Page) {
  await page.route("https://preview-browser.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/media.mp4") {
      const range = /bytes=(\d+)-(\d*)/.exec(
        route.request().headers().range ?? "",
      );
      if (range) {
        const start = Number(range[1]),
          end = Math.min(
            video.length - 1,
            range[2] ? Number(range[2]) : video.length - 1,
          );
        return route.fulfill({
          status: 206,
          contentType: "video/mp4",
          headers: {
            "accept-ranges": "bytes",
            "content-range": `bytes ${start}-${end}/${video.length}`,
          },
          body: video.subarray(start, end + 1),
        });
      }
      return route.fulfill({
        contentType: "video/mp4",
        headers: { "accept-ranges": "bytes" },
        body: video,
      });
    }
    if (url.pathname === "/thumbnail.jpg")
      return route.fulfill({ contentType: "image/jpeg", body: thumbnail });
    if (url.pathname === "/wave.json")
      return route.fulfill({
        json: {
          schemaVersion: 1,
          versionId: "11111111-1111-4111-8111-111111111111",
          hash: "a".repeat(64),
          originUs: 0,
          sampleRate: 8000,
          levels: [
            {
              stepUs: 100000,
              peaks: Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.5 : -0.5)),
            },
          ],
        },
      });
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ja"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    });
  });
  await page.goto("https://preview-browser.test/");
  await page.addScriptTag({ content: bundle });
  await expect
    .poll(() =>
      page.locator("video").evaluate((v) => (v as HTMLVideoElement).readyState),
    )
    .toBeGreaterThan(0);
}
test("media clock seek/frame stepping, non-destructive trim and signed-access recovery", async ({
  page,
}) => {
  await open(page);
  expect(
    await page.locator("video").getAttribute("playsinline"),
  ).not.toBeNull();
  const time = page.getByLabel("現在時刻", { exact: true });
  await time.fill("0.4");
  await time.press("Enter");
  await time.blur();
  await page.getByRole("button", { name: "＋1frame", exact: true }).click();
  await expect(time).toHaveValue("00:00:00.416667");
  await page.getByRole("button", { name: "再認可・再確認" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { previewResolveCalls: number })
            .previewResolveCalls,
      ),
    )
    .toBeGreaterThan(1);
  await expect(time).toHaveValue("00:00:00.416667");
  const end = page.getByLabel("clip 1 終了", { exact: true });
  await end.fill("2.5");
  await end.press("Tab");
  await expect(page.getByTestId("saved-count")).toHaveText("1");
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("axfluxo-developer", 1);
      r.onsuccess = () => resolve(r.result);
    });
    return await new Promise((resolve) => {
      const r = db
        .transaction("documents")
        .objectStore("documents")
        .get("fixture-preview");
      r.onsuccess = () => {
        db.close();
        resolve(r.result);
      };
    });
  });
  expect(JSON.stringify(stored)).toContain('"endUs":2500000');
  expect(JSON.stringify(stored)).toContain(
    '"versionId":"11111111-1111-4111-8111-111111111111"',
  );
  await page.evaluate(() =>
    (
      window as unknown as { setPreviewFailure: (c: string) => void }
    ).setPreviewFailure("AUTH_EXPIRED"),
  );
  await page.getByRole("button", { name: "再認可・再確認" }).click();
  await expect(page.getByRole("alert")).toContainText("認証の期限");
});
test("FNF overlaps and whole-range moves remain transient", async ({
  page,
}) => {
  await open(page);
  await page.getByLabel("fixture mode").selectOption("fnf");
  await page.getByRole("button", { name: "独立rangeを追加" }).click();
  await page.getByRole("button", { name: "独立rangeを追加" }).click();
  await expect(page.getByLabel("range 1 開始", { exact: true })).toHaveValue(
    "00:00:00.000000",
  );
  await expect(page.getByLabel("range 2 開始", { exact: true })).toHaveValue(
    "00:00:00.000000",
  );
  await page.getByLabel("range 1 譜面名").fill("未送信譜面");
  await page
    .getByRole("button", { name: "range 1 全体＋1秒", exact: true })
    .click();
  await expect(page.getByLabel("range 1 開始", { exact: true })).toHaveValue(
    "00:00:01.000000",
  );
  await expect(page.getByLabel("range 1 終了", { exact: true })).toHaveValue(
    "00:00:02.000000",
  );
  await page
    .getByRole("button", { name: "range 1 を再生", exact: true })
    .click();
  await expect(page.getByLabel("現在時刻", { exact: true })).toHaveValue(
    "00:00:02.000000",
  );
  await expect(page.getByTestId("saved-count")).toHaveText("0");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "未送信譜面",
  );
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  const box = await page.locator("video").boundingBox();
  expect(box!.height / box!.width).toBeCloseTo(16 / 9, 1);
});
test("pinch cancels a handle draft; pointercancel, IME and landscape/background remain safe", async ({
  page,
}) => {
  await open(page);
  const handle = page.getByRole("button", { name: "clip 1 開始handle" }),
    timeline = page.getByTestId("video-timeline"),
    box = (await handle.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await page.mouse.move(box.x + 22, box.y + 22);
  await page.mouse.down();
  await timeline.dispatchEvent("pointerdown", {
    pointerId: 7,
    pointerType: "touch",
    clientX: box.x + 110,
    clientY: box.y + 22,
    button: 0,
  });
  await timeline.dispatchEvent("pointermove", {
    pointerId: 7,
    pointerType: "touch",
    clientX: box.x + 180,
    clientY: box.y + 22,
    button: 0,
  });
  await timeline.dispatchEvent("pointercancel", {
    pointerId: 7,
    pointerType: "touch",
  });
  await page.mouse.up();
  await expect(page.getByTestId("source-start")).toHaveText("0");
  await expect(page.getByTestId("saved-count")).toHaveText("0");
  const start = page.getByLabel("clip 1 開始", { exact: true });
  await start.dispatchEvent("compositionstart");
  await start.fill("０．５");
  await start.press("Enter");
  await expect(page.getByTestId("source-start")).toHaveText("0");
  await start.dispatchEvent("compositionend", { data: "０．５" });
  await start.blur();
  await expect(page.getByTestId("source-start")).toHaveText("500000");
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(
    page.getByRole("button", { name: "＋1frame", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "再生", exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(
    await page.locator("video").evaluate((v) => (v as HTMLVideoElement).paused),
  ).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByTestId("source-start")).toHaveText("500000");
});

test("joined clips keep marker/source coordinates and play across a cut", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "fixture joined clips" }).click();
  await expect(page.getByLabel("全長", { exact: true })).toHaveText(
    "00:00:00.800000",
  );
  const time = page.getByLabel("現在時刻", { exact: true });
  await time.fill("0.1");
  await time.press("Enter");
  await time.blur();
  await page.getByRole("button", { name: "現在位置にmarkerを追加" }).click();
  await expect(page.getByTestId("saved-count")).toHaveText("1");
  await page.getByRole("button", { name: "再生", exact: true }).click();
  await expect(time).toHaveValue("00:00:00.800000");
  expect(
    await page
      .locator("video")
      .evaluate((v) => (v as HTMLVideoElement).currentTime),
  ).toBeCloseTo(1.4, 3);
});

test("trim thumbs resize both edges, preview drafts, cancel touch edits and support keyboard nudging", async ({
  page,
}) => {
  await open(page);
  const start = page.getByRole("button", { name: "clip 1 開始handle" });
  const end = page.getByRole("button", { name: "clip 1 終了handle" });
  const timeline = page.getByTestId("video-timeline");
  await start.scrollIntoViewIfNeeded();
  const box = (await start.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBe(88);
  await page.mouse.move(box.x + 22, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 102, box.y + 60, { steps: 5 });
  await expect(page.getByTestId("source-start")).toHaveText("0");
  await expect(page.locator('output[aria-live="polite"]')).toContainText(
    "長さ",
  );
  await page.mouse.up();
  await expect(page.getByTestId("source-start")).toHaveText("1000000");
  await expect(page.getByTestId("saved-count")).toHaveText("1");
  const endBox = (await end.boundingBox())!;
  await end.dispatchEvent("pointerdown", {
    pointerId: 9,
    pointerType: "touch",
    clientX: endBox.x + 22,
    clientY: endBox.y + 60,
    button: 0,
  });
  await timeline.dispatchEvent("pointermove", {
    pointerId: 9,
    pointerType: "touch",
    clientX: endBox.x - 18,
    clientY: endBox.y + 60,
  });
  await timeline.dispatchEvent("pointerup", {
    pointerId: 9,
    pointerType: "touch",
    clientX: endBox.x - 18,
    clientY: endBox.y + 60,
  });
  await expect(page.getByLabel("clip 1 終了", { exact: true })).toHaveValue(
    "00:00:02.500000",
  );
  await expect(page.getByTestId("saved-count")).toHaveText("2");
  await start.dispatchEvent("pointerdown", {
    pointerId: 10,
    pointerType: "touch",
    clientX: box.x + 22,
    clientY: box.y + 60,
    button: 0,
  });
  await timeline.dispatchEvent("pointermove", {
    pointerId: 10,
    pointerType: "touch",
    clientX: box.x + 62,
    clientY: box.y + 60,
  });
  await timeline.dispatchEvent("pointercancel", {
    pointerId: 10,
    pointerType: "touch",
  });
  await expect(page.getByTestId("source-start")).toHaveText("1000000");
  await expect(page.getByTestId("saved-count")).toHaveText("2");
  await start.focus();
  await start.press("ArrowRight");
  await expect(page.getByTestId("source-start")).toHaveText("1016667");
});
