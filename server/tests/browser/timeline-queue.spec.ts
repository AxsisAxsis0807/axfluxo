import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let bundle: string, file: string;
test.beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "timeline-queue-"));
  file = join(dir, "source.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=blue:size=160x90:rate=30:duration=8",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=8",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-c:a",
    "aac",
    "-y",
    file,
  ]);
  bundle = (
    await build({
      entryPoints: [
        new URL("timeline-queue-fixture.tsx", import.meta.url).pathname,
      ],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"test"' },
    })
  ).outputFiles[0].text;
});
async function open(page: Page, path: string) {
  await page.route("https://timeline.test/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
    }),
  );
  await page.goto(`https://timeline.test/${path}`);
  await page.addScriptTag({ content: bundle });
}
for (const mobile of [false, true])
  test(`trim clamps seeks, scroll and playback; can re-expand (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: 844 });
    await open(page, "timeline");
    await page.getByLabel("file", { exact: true }).setInputFiles(file);
    const video = page.locator("video");
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeCloseTo(2, 1);
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = 0;
    });
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeCloseTo(2, 1);
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = 7;
    });
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeCloseTo(6, 1);
    const timeline = page.getByTestId("video-timeline");
    await timeline.evaluate((n) => {
      n.scrollLeft = 1e6;
    });
    const geometry = await timeline.evaluate((n) => ({
      left: n.scrollLeft,
      max: n.scrollWidth - n.clientWidth,
    }));
    expect(geometry.left).toBeLessThanOrEqual(geometry.max);
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = 5.8;
    });
    await page.getByRole("button", { name: "範囲を再生", exact: true }).click();
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.paused))
      .toBe(true);
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeCloseTo(6, 1);
    await page.getByRole("button", { name: "範囲を再生", exact: true }).click();
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeLessThan(3);
    await video.evaluate((v: HTMLVideoElement) => v.pause());
    await page
      .getByRole("button", { name: "トリミング範囲を編集", exact: true })
      .click();
    const handle = page.getByRole("button", {
      name: "trim 開始handle",
      exact: true,
    });
    await handle.focus();
    await handle.press("Shift+ArrowLeft");
    await expect
      .poll(() => page.getByLabel("trim start").inputValue().then(Number))
      .toBeLessThan(2);
    await page.getByLabel("trim start").fill("1");
    await page.getByLabel("trim end").fill("7");
    await page
      .getByRole("button", { name: "通常再生に戻る", exact: true })
      .click();
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = 0;
    });
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeCloseTo(1, 1);
    await page
      .getByRole("button", { name: "拡大", exact: true })
      .click({ clickCount: 3 });
    await timeline.focus();
    await timeline.press("Home");
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeCloseTo(1, 1);
    await timeline.press("ArrowLeft");
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeCloseTo(1, 1);
    await timeline.press("End");
    await timeline.press("ArrowRight");
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeCloseTo(7, 1);
    await timeline.dispatchEvent("pointerdown", {
      pointerId: 10,
      pointerType: "touch",
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    await timeline.dispatchEvent("pointerdown", {
      pointerId: 11,
      pointerType: "touch",
      button: 0,
      clientX: 200,
      clientY: 100,
    });
    await timeline.dispatchEvent("pointermove", {
      pointerId: 11,
      pointerType: "touch",
      clientX: 300,
      clientY: 100,
    });
    await timeline.dispatchEvent("pointerup", {
      pointerId: 11,
      pointerType: "touch",
      clientX: 300,
      clientY: 100,
    });
    await timeline.dispatchEvent("pointerup", {
      pointerId: 10,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    await expect(page.getByTestId("timeline-head")).toBeVisible();
  });
test("real queue keeps snapshots, auto-runs 3 jobs and survives editor/panel unmount", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "queue");
  test.skip(
    await page.evaluate(
      () =>
        typeof MediaRecorder === "undefined" ||
        ![
          "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
          "video/mp4",
          "video/webm;codecs=vp8,opus",
        ].some((type) => MediaRecorder.isTypeSupported(type)),
    ),
    "This browser has no local encoder; playback and queue unit tests still run.",
  );
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(file);
  const range = page
    .locator("fieldset")
    .filter({ has: page.locator("legend", { hasText: /^range 1$/ }) });
  await range.getByLabel("譜面名", { exact: true }).fill("NORMAL");
  await range.getByLabel("開始秒", { exact: true }).fill("1");
  await range.getByLabel("終了秒", { exact: true }).fill("3");
  await page
    .getByRole("button", { name: "端末内で書き出す", exact: true })
    .click();
  await range.getByLabel("譜面名", { exact: true }).fill("SLOWED");
  await page
    .getByRole("button", { name: "端末内で書き出す", exact: true })
    .click();
  await range.getByLabel("譜面名", { exact: true }).fill("SUPER SLOWED");
  await page
    .getByRole("button", { name: "端末内で書き出す", exact: true })
    .click();
  await page.getByRole("button", { name: /詳細を開く/ }).click();
  const panel = page.getByRole("dialog", { name: "エクスポート管理" });
  await expect(panel.locator("article")).toHaveCount(3);
  await panel
    .getByRole("button", { name: "詳細を閉じる", exact: true })
    .click();
  await page.getByRole("button", { name: "編集画面の開閉" }).click();
  await expect(
    page.getByRole("heading", { name: "FNF Showcase Maker" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /詳細を開く/ }).click();
  await expect(panel.getByRole("link", { name: /を保存/ })).toHaveCount(3, {
    timeout: 40000,
  });
  const names = await panel
    .getByRole("link", { name: /を保存/ })
    .allTextContents();
  expect(names[0]).toContain("NORMAL");
  expect(names[1]).toContain("SLOWED");
  expect(names[2]).toContain("SUPER SLOWED");
  await expect(
    page.getByRole("complementary", { name: "エクスポートミニバー" }),
  ).toContainText("100%");
  const download = page.waitForEvent("download");
  await panel
    .getByRole("link", { name: /を保存/ })
    .first()
    .click();
  expect((await download).suggestedFilename()).toContain("NORMAL");
});
test("running cancellation releases media before next job, failure continues and retry is available", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await open(page, "queue");
  test.skip(
    await page.evaluate(
      () =>
        typeof MediaRecorder === "undefined" ||
        ![
          "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
          "video/mp4",
          "video/webm;codecs=vp8,opus",
        ].some((type) => MediaRecorder.isTypeSupported(type)),
    ),
    "This browser has no local encoder; playback and queue unit tests still run.",
  );
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(file);
  await page.getByLabel("譜面名", { exact: true }).fill("CANCEL ME");
  await page.getByLabel("終了秒", { exact: true }).fill("6");
  await page
    .getByRole("button", { name: "端末内で書き出す", exact: true })
    .click();
  await page.evaluate(() => {
    const api = window as unknown as {
      localExportQueue: import("../../../src/services/video/export-queue").ExportQueue;
      allowRead?: boolean;
    };
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!.files![0];
    const url = URL.createObjectURL(input);
    const base = {
      width: 160,
      height: 90,
      draw: (ctx: CanvasRenderingContext2D, media: HTMLVideoElement) =>
        ctx.drawImage(media, 0, 0, 160, 90),
    };
    api.localExportQueue.enqueue(
      [
        {
          ...base,
          filename: "RETRY.mp4",
          pieces: [
            {
              start: 1,
              end: 2,
              url: async () => {
                if (!api.allowRead) throw Error("TEST_READ_FAILURE");
                return url;
              },
            },
          ],
        },
        {
          ...base,
          filename: "FOLLOWUP.mp4",
          pieces: [{ start: 1, end: 2, file: input, url: async () => url }],
        },
      ],
      false,
    );
  });
  await page.getByRole("button", { name: /詳細を開く/ }).click();
  const panel = page.getByRole("dialog", { name: "エクスポート管理" });
  await panel
    .locator("article")
    .first()
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(panel.locator("article").first()).toContainText("cancelled");
  const retry = panel
    .locator("article")
    .filter({ has: page.locator("strong", { hasText: /^RETRY.mp4$/ }) });
  await expect(retry).toContainText("TEST_READ_FAILURE");
  await expect(
    panel.getByRole("link", { name: "FOLLOWUP.mp4を保存", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.evaluate(() => {
    Object.assign(window, { allowRead: true });
  });
  await retry.getByRole("button", { name: "再試行", exact: true }).click();
  await expect(
    retry.getByRole("link", { name: "RETRY.mp4を保存", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(panel.locator("article").first()).not.toContainText("completed");
  await page.evaluate(() => {
    sessionStorage.removeItem("axfluxo.developer.local-unlock.v1");
    window.dispatchEvent(new Event("axfluxo-local-lock-change"));
  });
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "エクスポートミニバー" }),
  ).toHaveCount(0);
});
