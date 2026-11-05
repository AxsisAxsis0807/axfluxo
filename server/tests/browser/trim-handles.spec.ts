import { test, expect, type Page, type Locator } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let bundle: string, source: string, css: string;
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
test.beforeAll(async () => {
  source = join(await mkdtemp(join(tmpdir(), "trim-handles-")), "source.mp4");
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
    source,
  ]);
  css = (await readFile("src/app/globals.css", "utf8")).replace(
    /@import[^;]+;/g,
    "",
  );
  bundle = (
    await build({
      entryPoints: [new URL("recovery-fixture.tsx", import.meta.url).pathname],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"test"' },
    })
  ).outputFiles[0].text;
});
async function open(page: Page, mode: string) {
  await page.route("https://trim.test/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>`,
    }),
  );
  await page.goto(`https://trim.test/${mode}`);
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled();
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(source);
  await expect(page.getByTestId("video-timeline")).toBeVisible();
}
async function visibleHandle(handle: Locator) {
  await expect(handle).toBeVisible();
  await handle.evaluate((n) =>
    n.scrollIntoView({ block: "center", inline: "nearest" }),
  );
  const result = await handle.evaluate((n) => {
    const r = n.getBoundingClientRect(),
      v = n.closest('[data-testid="video-timeline"]')!.getBoundingClientRect();
    const x = r.x + r.width / 2,
      y = r.y + r.height / 2;
    const grip = n.querySelector("span")!.getBoundingClientRect();
    return {
      width: r.width,
      height: r.height,
      inside: x >= v.left && x <= v.right && y >= v.top && y <= v.bottom,
      hit: n.contains(document.elementFromPoint(x, y)),
      gripWidth: grip.width,
      gripHeight: grip.height,
      opacity: getComputedStyle(n).opacity,
      gripOpacity: getComputedStyle(n.querySelector("span")!).opacity,
      gripBackground: getComputedStyle(n.querySelector("span")!)
        .backgroundColor,
    };
  });
  expect(result.inside).toBe(true);
  expect(result.hit).toBe(true);
  expect(result.width).toBeGreaterThanOrEqual(44);
  expect(result.height).toBeGreaterThanOrEqual(44);
  expect(result.gripWidth).toBeGreaterThan(0);
  expect(result.gripHeight).toBeGreaterThan(0);
  expect(result.opacity).toBe("1");
  expect(result.gripOpacity).toBe("1");
  expect(result.gripBackground).not.toBe("rgba(0, 0, 0, 0)");
}
for (const mode of ["all", "fnf"]) {
  test(`${mode}: trim handles are visible on import and both endpoints are usable`, async ({
    page,
  }) => {
    await open(page, mode);
    const start = page.locator('[data-action="start"]'),
      end = page.locator('[data-action="end"]');
    await visibleHandle(start);
    await expect(end).toBeAttached();
    // Both markers fit at this zoom; their centers must represent their actual times.
    for (let i = 0; i < 5; i++)
      await page.getByRole("button", { name: "縮小", exact: true }).click();
    await visibleHandle(start);
    await visibleHandle(end);
    const geometry = await page.getByTestId("video-timeline").evaluate((n) => {
      const a = n
        .querySelector('[data-action="start"]')!
        .getBoundingClientRect();
      const b = n.querySelector('[data-action="end"]')!.getBoundingClientRect();
      return b.x - a.x;
    });
    const pps = Number(
      (await page.getByLabel("timeline倍率").textContent())!.split(" ")[0],
    );
    expect(Math.abs(geometry - 8 * pps)).toBeLessThan(1);
  });
  test(`${mode}: offscreen trim stays at its real time after scroll`, async ({
    page,
  }) => {
    await open(page, mode);
    await page
      .getByRole("button", { name: "トリミング範囲を編集", exact: true })
      .click();
    const timeline = page.getByTestId("video-timeline");
    await timeline.evaluate((n) => {
      n.scrollLeft = 320;
    });
    await expect
      .poll(() => timeline.evaluate((n) => n.scrollLeft))
      .toBeCloseTo(320, 0);
    const result = await timeline.evaluate((n) => {
      const v = n.getBoundingClientRect();
      const a = n
        .querySelector('[data-action="start"]')!
        .getBoundingClientRect();
      const b = n.querySelector('[data-action="end"]')!.getBoundingClientRect();
      return {
        start: a.x + a.width / 2 - v.x - n.clientLeft,
        end: b.x + b.width / 2 - v.x - n.clientLeft,
        width: n.clientWidth,
      };
    });
    expect(result.start).toBeCloseTo(result.width / 2 - 320, 0);
    expect(result.end).toBeCloseTo(result.width / 2 + 320, 0);
  });
}

// Chromium injects trusted touchscreen input, including hit testing and capture.
// Playwright's WebKit API only exposes tap; its drag path below exercises touch
// PointerEvents explicitly. Physical iPhone gesture arbitration remains manual.
async function touchDrag(page: Page, handle: Locator, dx: number, dy = 0) {
  await visibleHandle(handle);
  const b = (await handle.boundingBox())!;
  const x = b.x + b.width / 2,
    y = b.y + b.height / 2;
  const gesturePageY = await page.evaluate(() => window.scrollY);
  if (page.context().browser()!.browserType().name() === "chromium") {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 0 }],
    });
    for (let i = 1; i <= 10; i++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (dx * i) / 10, y: y + (dy * i) / 10, id: 0 }],
      });
      await page.waitForTimeout(20);
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(gesturePageY);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await session.detach();
  } else {
    await handle.dispatchEvent("pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: x,
      clientY: y,
    });
    const timeline = page.getByTestId("video-timeline");
    for (let i = 1; i <= 10; i++)
      await timeline.dispatchEvent("pointermove", {
        pointerId: 1,
        pointerType: "touch",
        clientX: x + (dx * i) / 10,
        clientY: y + (dy * i) / 10,
      });
    expect(await page.evaluate(() => window.scrollY)).toBe(gesturePageY);
    await timeline.dispatchEvent("pointerup", {
      pointerId: 1,
      pointerType: "touch",
      clientX: x + dx,
      clientY: y + dy,
    });
  }
}
for (const mode of ["all", "fnf"]) {
  test(`${mode}: touch edits endpoints, snaps, preserves order and restores autosaved trim`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await open(page, mode);
    const timeline = page.getByTestId("video-timeline");
    const start = page.locator('[data-action="start"]'),
      end = page.locator('[data-action="end"]');
    const startField = page.getByLabel("開始秒", { exact: true }),
      endField = page.getByLabel("終了秒", { exact: true });
    await touchDrag(page, start, 80, 25);
    await expect
      .poll(() => startField.inputValue().then(Number))
      .toBeCloseTo(1, 2);
    await page
      .getByRole("button", { name: "トリミング範囲を編集", exact: true })
      .click();
    // Source end can be centered and edited inwards.
    await timeline.focus();
    await timeline.press("End");
    await visibleHandle(end);
    await touchDrag(page, end, -80, 25);
    await expect
      .poll(() => endField.inputValue().then(Number))
      .toBeCloseTo(7, 2);
    // Center on four seconds. Pull start onto the center's ten-pixel snap zone.
    await timeline.evaluate((n) => {
      n.scrollLeft = 320;
    });
    await expect
      .poll(() => timeline.evaluate((n) => n.scrollLeft))
      .toBeCloseTo(320, 0);
    // Bring start on screen without changing center: zoom out to 35.56 px/s.
    for (let i = 1; i <= 2; i++) {
      await page.getByRole("button", { name: "縮小", exact: true }).tap();
      await expect(page.getByLabel("timeline倍率")).toHaveText(
        `${(80 / 1.5 ** i).toFixed(1)} px/秒`,
      );
    }
    await visibleHandle(start);
    const s = (await start.boundingBox())!,
      h = (await page.getByTestId("timeline-head").boundingBox())!;
    const zoom = 80 / 1.5 ** 2;
    const centralUs = await timeline.evaluate(
      (n, pps) => Math.round((n.scrollLeft / pps) * 1e6),
      zoom,
    );
    await touchDrag(page, start, h.x - (s.x + s.width / 2) + 4);
    await expect(startField).toHaveValue(String(centralUs / 1e6));
    // Deliberately cross end: clamp to one frame before it, never reverse.
    await touchDrag(page, start, 150);
    const a = Number(await startField.inputValue()),
      b = Number(await endField.inputValue());
    expect(a).toBeLessThan(b);
    expect(b - a).toBeCloseTo(0.016667, 5);
    await expect(page.getByTestId("local-save-status")).toContainText(
      "この端末に自動保存済み",
    );
    await page.reload();
    // Recovery deliberately waits for the previous tab's ~20s writer lease.
    await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled({
      timeout: 35000,
    });
    await expect(startField).toHaveValue(String(a));
    await expect(endField).toHaveValue(String(b));
    await visibleHandle(start);
    await visibleHandle(end);
  });
  test(`${mode}: zoom and pinch retain center and real marker coordinates`, async ({
    page,
  }) => {
    await open(page, mode);
    await page
      .getByRole("button", { name: "トリミング範囲を編集", exact: true })
      .click();
    const timeline = page.getByTestId("video-timeline");
    await timeline.evaluate((n) => {
      n.scrollLeft = 320;
    });
    await expect
      .poll(() => timeline.evaluate((n) => n.scrollLeft))
      .toBeCloseTo(320, 0);
    await page.getByRole("button", { name: "拡大", exact: true }).click();
    await expect
      .poll(() => timeline.evaluate((n) => n.scrollLeft))
      .toBeCloseTo(480, 0);
    const box = (await timeline.boundingBox())!,
      y = box.y + 20;
    for (const [pointerId, clientX] of [
      [10, box.x + 100],
      [11, box.x + 200],
    ]) {
      await timeline.dispatchEvent("pointerdown", {
        pointerId,
        pointerType: "touch",
        button: 0,
        clientX,
        clientY: y,
      });
    }
    await timeline.dispatchEvent("pointermove", {
      pointerId: 11,
      pointerType: "touch",
      clientX: box.x + 300,
      clientY: y,
    });
    await timeline.dispatchEvent("pointerup", {
      pointerId: 11,
      pointerType: "touch",
      clientX: box.x + 300,
      clientY: y,
    });
    await timeline.dispatchEvent("pointerup", {
      pointerId: 10,
      pointerType: "touch",
      clientX: box.x + 100,
      clientY: y,
    });
    await expect(page.getByLabel("timeline倍率")).toHaveText("240.0 px/秒");
    await expect
      .poll(() => timeline.evaluate((n) => n.scrollLeft))
      .toBeCloseTo(960, 0);
    const geometry = await timeline.evaluate((n) => {
      const r = n.getBoundingClientRect(),
        h = n
          .querySelector('[data-testid="timeline-head"]')!
          .getBoundingClientRect();
      return {
        head: h.x - r.x - n.clientLeft,
        width: n.clientWidth,
        start:
          (n.querySelector('[data-action="start"]') as HTMLElement).offsetLeft +
          22,
        end:
          (n.querySelector('[data-action="end"]') as HTMLElement).offsetLeft +
          22,
      };
    });
    expect(geometry.head).toBeCloseTo(geometry.width / 2, 0);
    expect(geometry.start).toBeCloseTo(geometry.width / 2, 0);
    expect(geometry.end).toBeCloseTo(geometry.width / 2 + 8 * 240, 0);
  });
}

test("All Versions trim edges cannot cross or erase Version boundaries", async ({
  page,
}) => {
  await open(page, "all");
  await page.getByLabel("version境界（素材内の秒、カンマ区切り）").fill("2,6");
  await page
    .getByRole("button", { name: "トリミング範囲を編集", exact: true })
    .click();
  for (let i = 0; i < 4; i++)
    await page.getByRole("button", { name: "縮小", exact: true }).click();
  await touchDrag(page, page.locator('[data-action="start"]'), 180);
  await expect(page.getByLabel("開始秒", { exact: true })).toHaveValue(
    "1.999999",
  );
  await touchDrag(page, page.locator('[data-action="end"]'), -180);
  await expect(page.getByLabel("終了秒", { exact: true })).toHaveValue(
    "6.000001",
  );
  await expect(
    page.getByLabel("version境界（素材内の秒、カンマ区切り）"),
  ).toHaveValue("2,6");
});
