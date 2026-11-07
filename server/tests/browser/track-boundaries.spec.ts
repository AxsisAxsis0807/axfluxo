import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
let app: string, worker: string;
test.beforeAll(async () => {
  app = (
    await build({
      entryPoints: [new URL("recovery-fixture.tsx", import.meta.url).pathname],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"test"',
        "process.env.NEXT_PUBLIC_BASE_PATH": '""',
      },
    })
  ).outputFiles[0].text;
  worker = (
    await build({
      entryPoints: ["src/services/video/track-boundary.worker.ts"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
    })
  ).outputFiles[0].text;
});
function wav() {
  const rate = 8000,
    count = 42 * rate,
    buffer = Buffer.alloc(44 + count * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const t = i / rate;
    buffer.writeInt16LE(
      t >= 20 && t < 21
        ? 0
        : Math.round(16000 * Math.sin(2 * Math.PI * (t < 20 ? 220 : 1400) * t)),
      44 + i * 2,
    );
  }
  return buffer;
}
async function open(page: Page) {
  await page.route("https://boundaries.test/**", (r) =>
    r.fulfill(
      r.request().url().endsWith("/workers/track-boundary-v1.js")
        ? { contentType: "application/javascript", body: worker }
        : {
            contentType: "text/html",
            body: `<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script>${app.replace(/<\/script/gi, "<\\/script")}</script>`,
          },
    ),
  );
  await page.goto("https://boundaries.test/all");
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled();
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles({
    name: "tracks.wav",
    mimeType: "audio/wav",
    buffer: wav(),
  });
  await expect(page.getByTestId("video-timeline")).toBeVisible();
}
async function pinch(page: Page, factor: number) {
  const timeline = page.getByTestId("video-timeline");
  const box = (await timeline.boundingBox())!;
  for (const [pointerId, x] of [
    [71, 60],
    [72, 160],
  ])
    await timeline.dispatchEvent("pointerdown", {
      pointerId,
      pointerType: "touch",
      button: 0,
      clientX: box.x + x,
      clientY: box.y + 20,
    });
  for (const pointerId of [72, 71]) {
    if (pointerId === 72)
      await timeline.dispatchEvent("pointermove", {
        pointerId,
        pointerType: "touch",
        clientX: box.x + 60 + 100 * factor,
        clientY: box.y + 20,
      });
    await timeline.dispatchEvent("pointerup", {
      pointerId,
      pointerType: "touch",
      clientX: box.x + (pointerId === 71 ? 60 : 60 + 100 * factor),
      clientY: box.y + 20,
    });
  }
}
test("PCM analysis, candidate navigation, candidate addition, audition, deletion and recovery", async ({
  page,
}) => {
  test.setTimeout(90000);
  await open(page);
  const field = page.getByLabel("version境界（素材内の秒、カンマ区切り）");
  await field.fill("18,30");
  await page
    .getByRole("button", { name: "曲間を自動検出", exact: true })
    .click();
  const smart = page.getByRole("region", {
    name: "Smart Track Boundary Detection",
  });
  await expect(smart).toContainText("1件。", { timeout: 30000 });
  await expect(field).toHaveValue("18,30");
  const candidate = smart.locator("li").first();
  await expect(candidate).toContainText("高信頼度");
  await candidate.getByRole("button", { name: "移動", exact: true }).click();
  await expect
    .poll(() =>
      page.getByTestId("video-timeline").evaluate((n) => n.scrollLeft),
    )
    .toBeCloseTo(1640, 0);
  const timeline = page.getByTestId("video-timeline");
  await timeline.locator('[data-index="0"]').dispatchEvent("pointerdown", {
    pointerId: 10,
    pointerType: "touch",
    button: 0,
    clientX: 200,
    clientY: 30,
  });
  await timeline.dispatchEvent("pointerup", {
    pointerId: 10,
    pointerType: "touch",
    clientX: 200,
    clientY: 30,
  });
  await candidate
    .getByRole("button", { name: "境界として適用", exact: true })
    .click();
  await expect(field).toHaveValue("18,20.5,30");
  await candidate.getByRole("button", { name: "試聴", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator("video")
        .first()
        .evaluate((n) => (n as HTMLVideoElement).paused),
    )
    .toBe(false);
  await smart.getByRole("button", { name: "試聴停止", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator("video")
        .first()
        .evaluate((n) => (n as HTMLVideoElement).paused),
    )
    .toBe(true);
  await candidate.getByRole("button", { name: "削除", exact: true }).click();
  await expect(smart).toContainText("0件。");
  await expect(smart.locator("li")).toHaveCount(0);
  await smart.locator("summary").click();
  await smart.getByLabel("候補の最小間隔（秒）").fill("12");
  await expect(page.getByTestId("local-save-status")).toContainText(
    "この端末に自動保存済み",
  );
  await page.reload();
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled({
    timeout: 35000,
  });
  await expect(field).toHaveValue("18,20.5,30");
  await expect(smart.getByLabel("候補の最小間隔（秒）")).toHaveValue("12");
  await expect(smart.locator("li")).toHaveCount(0);
  await expect(
    smart.getByRole("button", { name: "曲間を自動検出", exact: true }),
  ).toBeDisabled();
});
test("repeated off-center pinches retain time, page scale and true endpoints", async ({
  page,
}) => {
  test.setTimeout(90000);
  // Reproduce WebKit's integer scrollLeft setter in Chromium as well. The
  // physical scroll + painted translation must still preserve the exact time.
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollLeft",
    )!;
    Object.defineProperty(Element.prototype, "scrollLeft", {
      configurable: true,
      get: descriptor.get,
      set(value: number) {
        descriptor.set!.call(this, Math.trunc(value));
      },
    });
  });
  await open(page);
  await page
    .getByRole("button", { name: "トリミング範囲を編集", exact: true })
    .click();
  const timeline = page.getByTestId("video-timeline");
  await page
    .locator("video")
    .first()
    .evaluate((n) => {
      (n as HTMLVideoElement).currentTime = 12.345625;
    });
  // 98765 / 8000 is a real sample position. WebKit exposes currentTime on
  // this PCM sample grid; keep the same 0.5 microsecond assertion before/after.
  await expect
    .poll(() =>
      page
        .locator("video")
        .first()
        .evaluate((n) => (n as HTMLVideoElement).currentTime),
    )
    .toBeCloseTo(12.345625, 6);
  await expect
    .poll(() =>
      timeline.evaluate(
        (n) =>
          n.scrollLeft -
          new DOMMatrixReadOnly(
            getComputedStyle(n.firstElementChild!).transform,
          ).m41,
      ),
    )
    .toBeCloseTo(12.345625 * 80, 0);
  for (let i = 0; i < 6; i++) {
    await pinch(page, 1.7);
    await pinch(page, 1 / 1.7);
    await expect
      .poll(() =>
        timeline.evaluate(
          (n) =>
            n.scrollLeft -
            new DOMMatrixReadOnly(
              getComputedStyle(n.firstElementChild!).transform,
            ).m41,
        ),
      )
      .toBeCloseTo(12.345625 * 80, 0);
    await expect
      .poll(() =>
        page
          .locator("video")
          .first()
          .evaluate((n) => (n as HTMLVideoElement).currentTime),
      )
      .toBeCloseTo(12.345625, 6);
  }
  await timeline.focus();
  await timeline.press("End");
  for (let i = 0; i < 6; i++) {
    await pinch(page, 1.7);
    await pinch(page, 1 / 1.7);
    await expect
      .poll(() =>
        timeline.evaluate(
          (n) =>
            n.scrollLeft -
            new DOMMatrixReadOnly(
              getComputedStyle(n.firstElementChild!).transform,
            ).m41,
        ),
      )
      .toBeCloseTo(42 * 80, 0);
    await expect(page.getByLabel("中央プレイヘッド時刻")).toHaveText(
      "42.000000 秒",
    );
    await expect
      .poll(() =>
        page
          .locator("video")
          .first()
          .evaluate((n) =>
            Math.floor((n as HTMLVideoElement).currentTime * 8000 + 1e-7),
          ),
      )
      .toBe(42 * 8000 - 1);
  }
  await expect(page.getByTestId("local-save-status")).toContainText(
    "この端末に自動保存済み",
  );
  await page.reload();
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled({
    timeout: 35000,
  });
  await expect(page.getByLabel("中央プレイヘッド時刻")).toHaveText(
    "42.000000 秒",
  );
  await expect
    .poll(() =>
      page
        .locator("video")
        .first()
        .evaluate((n) =>
          Math.floor((n as HTMLVideoElement).currentTime * 8000 + 1e-7),
        ),
    )
    .toBe(42 * 8000 - 1);
  await expect
    .poll(() =>
      timeline.evaluate(
        (n) =>
          n.scrollLeft -
          new DOMMatrixReadOnly(
            getComputedStyle(n.firstElementChild!).transform,
          ).m41,
      ),
    )
    .toBeCloseTo(42 * 80, 0);
  await timeline.focus();
  await timeline.press("Home");
  await pinch(page, 2);
  await expect.poll(() => timeline.evaluate((n) => n.scrollLeft)).toBe(0);
  const geometry = await timeline.evaluate((n) => ({
    head:
      n.querySelector('[data-testid="timeline-head"]')!.getBoundingClientRect()
        .x -
      n.getBoundingClientRect().x -
      n.clientLeft,
    width: n.clientWidth,
    scale: visualViewport?.scale,
  }));
  expect(geometry.head).toBeCloseTo(geometry.width / 2, 0);
  expect(geometry.scale).toBe(1);
});
test("cancellation preserves existing markers and can restart", async ({
  page,
}) => {
  await open(page);
  const smart = page.getByRole("region", {
    name: "Smart Track Boundary Detection",
  });
  const field = page.getByLabel("version境界（素材内の秒、カンマ区切り）");
  await field.fill("10,20,30");
  await smart
    .getByRole("button", { name: "曲間を自動検出", exact: true })
    .click();
  await smart
    .getByRole("button", { name: "曲間解析をキャンセル", exact: true })
    .click();
  await expect(field).toHaveValue("10,20,30");
  await expect(
    smart.getByRole("button", { name: "曲間を自動検出", exact: true }),
  ).toBeEnabled();
});
test("Version handles snap in CSS pixels, release, disable snap and stay between neighbours", async ({
  page,
}) => {
  await open(page);
  const field = page.getByLabel("version境界（素材内の秒、カンマ区切り）");
  await field.fill("18,30");
  await page
    .getByRole("button", { name: "曲間を自動検出", exact: true })
    .click();
  const smart = page.getByRole("region", {
    name: "Smart Track Boundary Detection",
  });
  await expect(smart).toContainText("1件。", { timeout: 30000 });
  await smart.getByRole("button", { name: "移動", exact: true }).click();
  const timeline = page.getByTestId("video-timeline");
  async function dragBy(dx: number) {
    const marker = timeline.locator('[data-index="0"]');
    const rect = (await marker.boundingBox())!;
    const x = rect.x + rect.width / 2,
      y = rect.y + 20;
    await marker.dispatchEvent("pointerdown", {
      pointerId: 22,
      pointerType: "touch",
      button: 0,
      clientX: x,
      clientY: y,
    });
    await timeline.dispatchEvent("pointermove", {
      pointerId: 22,
      pointerType: "touch",
      clientX: x + dx,
      clientY: y,
    });
    await timeline.dispatchEvent("pointerup", {
      pointerId: 22,
      pointerType: "touch",
      clientX: x + dx,
      clientY: y,
    });
  }
  await dragBy(204);
  await expect(field).toHaveValue("20.5,30");
  await dragBy(24);
  await expect(field).toHaveValue("20.8,30");
  await page
    .getByLabel("境界の吸着（中央・曲間候補）", { exact: true })
    .uncheck();
  await dragBy(-20);
  await expect(field).toHaveValue("20.55,30");
  await dragBy(1000);
  await expect(field).toHaveValue("29.999999,30");
});

test("three direct boundaries persist through move, nearest deletion and reload", async ({
  page,
}) => {
  test.setTimeout(90000);
  await open(page);
  const timeline = page.getByTestId("video-timeline");
  const field = page.getByLabel("version境界（素材内の秒、カンマ区切り）");
  await expect(
    page.getByRole("button", { name: "中央に手動マーカー追加", exact: true }),
  ).toHaveCount(0);
  async function seek(seconds: number) {
    await timeline.evaluate((n, seconds) => {
      n.scrollLeft = seconds * 80;
      n.dispatchEvent(new Event("scroll"));
    }, seconds);
    await expect(page.getByLabel("中央プレイヘッド時刻")).toHaveText(
      `${seconds.toFixed(6)} 秒`,
    );
  }
  for (const second of [10, 20, 30]) {
    await seek(second);
    await page
      .getByRole("button", { name: "Version境界を追加", exact: true })
      .click();
    await expect(field).toHaveValue(
      [10, 20, 30].filter((n) => n <= second).join(","),
    );
  }
  await page
    .getByRole("textbox", { name: "version名（1行に1つ）", exact: true })
    .fill("one\ntwo\nthree\nfour");
  for (const endpoint of [0, 42]) {
    await seek(endpoint);
    await page
      .getByRole("button", { name: "Version境界を追加", exact: true })
      .click();
    await expect(field).toHaveValue("10,20,30");
  }
  // Reproduce browsers exposing the physical final sample after an EOF seek.
  await page
    .locator("video")
    .first()
    .evaluate((video: HTMLVideoElement) => {
      video.dispatchEvent(new Event("pointerdown"));
      video.currentTime = 41.999999;
      video.dispatchEvent(new Event("timeupdate"));
    });
  await expect(page.getByLabel("中央プレイヘッド時刻")).toHaveText(
    "41.999999 秒",
  );
  await page
    .getByRole("button", { name: "Version境界を追加", exact: true })
    .click();
  await expect(field).toHaveValue("10,20,30");
  await seek(20);
  const marker = timeline.locator('[data-action="marker"][data-index="1"]');
  const box = (await marker.boundingBox())!;
  await marker.dispatchEvent("pointerdown", {
    pointerId: 91,
    pointerType: "touch",
    button: 0,
    clientX: box.x + 22,
    clientY: box.y + 20,
  });
  await timeline.dispatchEvent("pointerup", {
    pointerId: 91,
    pointerType: "touch",
    clientX: box.x + 102,
    clientY: box.y + 20,
    altKey: true,
  });
  await expect(field).toHaveValue("10,21,30");
  await seek(21.05);
  await page
    .getByRole("button", { name: "Version境界を削除", exact: true })
    .click();
  await expect(field).toHaveValue("10,30");
  await page
    .getByRole("button", { name: "Version境界を追加", exact: true })
    .click();
  await expect(field).toHaveValue("10,21.05,30");
  await expect(page.getByTestId("local-save-status")).toContainText(
    "この端末に自動保存済み",
  );
  await page.reload();
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled({
    timeout: 35000,
  });
  await expect(field).toHaveValue("10,21.05,30");
  await expect(
    page.getByRole("textbox", { name: "version名（1行に1つ）", exact: true }),
  ).toHaveValue("one\ntwo\nthree\nfour");
  await expect(
    page.getByRole("button", { name: "Version境界を削除", exact: true }),
  ).toBeVisible();
});
