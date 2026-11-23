import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let bundle: string, source: string, mp3: string;
test.beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "recovery-"));
  source = join(dir, "source.mp4");
  mp3 = join(dir, "tone.mp3");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    "-y",
    mp3,
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=blue:size=160x90:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-c:a",
    "aac",
    "-y",
    source,
  ]);
  bundle = (
    await build({
      entryPoints: [new URL("recovery-fixture.tsx", import.meta.url).pathname],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"test"', "process.env.NEXT_PUBLIC_BASE_PATH": '""' },
    })
  ).outputFiles[0].text;
});
async function open(page: Page) {
  await page.route("https://recovery.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>`,
    }),
  );
  for (const font of ["Aleo.ttf", "ReferenceClock.ttf"]) {
    await page.route("https://recovery.test/fonts/" + font, (route) =>
      route.fulfill({ path: "public/fonts/" + font, contentType: "font/ttf" }),
    );
  }
  await page.goto("https://recovery.test/fnf");
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled({
    timeout: 35000,
  });
}
async function resumeSaved(page: Page) {
  await page.getByRole("button", { name: /前回の作業を再開/ }).click({
    timeout: 35000,
  });
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled({
    timeout: 35000,
  });
}
async function durable(page: Page) {
  await expect(page.getByTestId("local-save-status")).toContainText(
    "この端末に自動保存済み",
  );
  await page.evaluate(async () => {
    await (
      window as unknown as { flushExportRecovery: () => Promise<void> }
    ).flushExportRecovery();
  });
}
test("a Safari IndexedDB open stall shows a safe retry instead of hanging forever", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const realOpen = indexedDB.open.bind(indexedDB);
    let attempts = 0;
    Object.defineProperty(indexedDB, "open", {
      configurable: true,
      value: (name: string, version?: number) => {
        if (name === "axfluxo.local-video-recovery" && attempts++ === 0)
          return {} as IDBOpenDBRequest;
        return version === undefined ? realOpen(name) : realOpen(name, version);
      },
    });
  });
  await page.route("https://recovery.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>`,
    }),
  );
  await page.goto("https://recovery.test/fnf");
  const retry = page.getByRole("button", { name: "保存データの確認を再試行" });
  await expect(retry).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText(/保存データは削除していません/).first()).toBeVisible();
  await retry.click();
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled({
    timeout: 30_000,
  });
});

test("All Versions accepts MP3 and has an unrestricted iOS picker fallback; FNF keeps video-only selection", async ({
  page,
}) => {
  test.setTimeout(60000);
  await open(page);
  await expect(page.getByLabel("端末の素材", { exact: true })).toHaveAttribute(
    "accept",
    "video/*",
  );
  await expect(
    page.getByLabel("形式の制限なしで素材を選択"),
  ).toHaveCount(0);

  await page.goto("https://recovery.test/all");
  const picker = page.getByLabel("端末の素材", { exact: true });
  await expect(picker).toBeEnabled({ timeout: 35000 });
  const formats = (await picker.getAttribute("accept"))?.split(",") ?? [];
  for (const ext of [".mp3", ".wav", ".m4a", ".mp4", ".mov"]) {
    expect(formats).toContain(ext);
  }
  expect(formats).not.toContain("audio/*");
  expect(formats).not.toContain("video/*");

  const fallback = page.getByLabel("形式の制限なしで素材を選択");
  await expect(fallback).toBeEnabled();
  expect(await fallback.getAttribute("accept")).toBeNull();

  await picker.setInputFiles(mp3);
  await expect(
    page.getByRole("group", { name: /素材 1：tone\.mp3/ }),
  ).toBeVisible();
  await fallback.setInputFiles(mp3);
  await expect(
    page.getByRole("group", { name: /素材 2：tone\.mp3/ }),
  ).toBeVisible();
});
test("All Versions has one active native decoder and releases it when switching or closing previews", async ({
  page,
}) => {
  test.setTimeout(90000);
  await open(page);
  await page.goto("https://recovery.test/all");
  const picker = page.getByLabel("端末の素材", { exact: true });
  await expect(picker).toBeEnabled({ timeout: 35000 });
  await picker.setInputFiles([source, source]);
  await expect(page.getByRole("group", { name: /素材 2：source\.mp4/ })).toBeVisible();
  const active = page.locator('audio[id^="local-media-"]');
  await expect(active).toHaveCount(1);
  await expect(page.locator('video[id^="local-media-"]')).toHaveCount(0);
  const first = await active.getAttribute("id");
  expect(await active.getAttribute("preload")).toBe("metadata");
  await page.getByRole("button", { name: "素材 2 のプレビューを読み込む" }).click();
  await expect(active).toHaveCount(1);
  expect(await active.getAttribute("id")).not.toBe(first);
  await page.getByRole("button", { name: "素材 2 のプレビューを閉じる" }).click();
  await expect(active).toHaveCount(0);
  await expect(page.getByRole("group", { name: /素材 1：source\.mp4/ })).toBeVisible();
  await expect(page.getByRole("group", { name: /素材 2：source\.mp4/ })).toBeVisible();
});
test("All Versions composition uses audio-only playback and a cover canvas", async ({
  page,
}) => {
  test.setTimeout(90000);
  await open(page);
  await page.goto("https://recovery.test/all");
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(source);
  await page.getByLabel("version名（1行に1つ）").fill("ONE");
  await page.getByLabel("カバー画像").setInputFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Yp8AAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.getByRole("button", { name: "合成プレビューを更新" }).click();
  const composition = page.getByRole("region", { name: "合成プレビュー" });
  await expect(composition).toBeVisible();
  await expect(composition.locator("audio")).toHaveCount(1);
  await expect(composition.locator("video")).toHaveCount(0);
  await expect(composition.locator("canvas")).toBeVisible();
});
test("editor files, trim, labels and timeline restore after opt-in and stay separate from All Versions", async ({
  page,
}) => {
  test.setTimeout(90000);
  await open(page);
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(source);
  await page.getByLabel("譜面名", { exact: true }).fill("RESTORED");
  await page
    .getByRole("button", { name: "中央に手動マーカー追加", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Smart Track Boundary Detection" })
      .locator("li"),
  ).toContainText("manual");
  await page.getByLabel("開始秒", { exact: true }).fill("0.5");
  await page.getByLabel("終了秒", { exact: true }).fill("2");
  await page.getByRole("button", { name: "拡大", exact: true }).click();
  const zoom = await page.getByLabel("timeline倍率").textContent();
  await durable(page);
  await page.reload();
  await resumeSaved(page);
  await expect(page.getByLabel("譜面名", { exact: true })).toHaveValue(
    "RESTORED",
  );
  await expect(page.getByLabel("開始秒", { exact: true })).toHaveValue("0.5");
  await expect(page.getByLabel("timeline倍率")).toHaveText(zoom!);
  await page.getByRole("button", {
    name: "素材 1 のプレビューを読み込む",
  }).click();
  expect(
    await page
      .locator("video")
      .first()
      .evaluate((v) => (v as HTMLVideoElement).src),
  ).toContain("blob:");
  await page.goto("https://recovery.test/all");
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled({
    timeout: 35000,
  });
  await expect(page.getByRole("group", { name: /^素材 1/ })).toHaveCount(0);
  await page
    .getByRole("button", { name: "端末内で書き出す", exact: true })
    .click();
  await expect(
    page.getByText("素材を選択してください。", { exact: true }).last(),
  ).toBeVisible();
});
test("durable queued jobs restart once; finished videos survive reload until each save is confirmed", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await open(page);
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(source);
  await page.getByLabel("譜面名", { exact: true }).fill("A");
  await page.getByLabel("終了秒", { exact: true }).fill("1.2");
  await page.getByRole("button", { name: "rangeを追加", exact: true }).click();
  await page.getByLabel("譜面名", { exact: true }).nth(1).fill("B");
  await page.getByLabel("終了秒", { exact: true }).nth(1).fill("1.5");
  await durable(page);
  const canEncode = await page.evaluate(
    () =>
      typeof MediaRecorder !== "undefined" &&
      typeof HTMLCanvasElement.prototype.captureStream === "function" &&
      [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp8,opus",
      ].some((type) => MediaRecorder.isTypeSupported(type)),
  );
  if (!canEncode) {
    // Exercise the actual non-support behavior; never skip or pretend a file was encoded.
    await page
      .getByRole("button", { name: "端末内で書き出す", exact: true })
      .click();
    await expect(
      page.getByText(
        /このブラウザーは端末内エンコードに対応していません|Canvasの動画書き出しに対応していません/,
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              localExportQueue: { getSnapshot: () => { entries: unknown[] } };
            }
          ).localExportQueue.getSnapshot().entries.length,
      ),
    ).toBe(0);
    await page.reload();
    await resumeSaved(page);
    await expect(
      page.getByLabel("譜面名", { exact: true }).first(),
    ).toHaveValue("A");
    await expect(page.getByLabel("譜面名", { exact: true }).nth(1)).toHaveValue(
      "B",
    );
    return;
  }
  await page.evaluate(() =>
    (
      window as unknown as { localExportQueue: { pause: () => void } }
    ).localExportQueue.pause(),
  );
  await page
    .getByRole("button", { name: "端末内で書き出す", exact: true })
    .click();
  await expect(
    page.getByText(
      "現在の設定で予約しました。下部の書き出しキューで確認できます。",
      { exact: true },
    ),
  ).toBeVisible();
  await durable(page);
  await page.reload();
  await resumeSaved(page);
  await page.getByRole("button", { name: /詳細を開く/ }).click();
  const permit = page.getByRole("button", {
    name: "音声処理を許可・キューを再開",
    exact: true,
  });
  if (await permit.isVisible()) await permit.click();
  const saveA = page.getByRole("link", { name: /^A\.(mp4|webm)を保存$/ });
  const saveB = page.getByRole("link", { name: /^B\.(mp4|webm)を保存$/ });
  await expect(saveA).toBeVisible({ timeout: 25000 });
  await expect(saveB).toBeVisible({ timeout: 25000 });
  const download = page.waitForEvent("download");
  await saveA.click();
  const result = await download;
  const path = info.outputPath(result.suggestedFilename());
  await result.saveAs(path);
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", path],
      { encoding: "utf8" },
    ),
  );
  expect(
    probe.streams.some((s: { codec_type: string }) => s.codec_type === "video"),
  ).toBe(true);
  expect(
    probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio"),
  ).toBe(true);
  await durable(page);
  await page.reload();
  await resumeSaved(page);
  await page.getByRole("button", { name: /詳細を開く/ }).click();
  await expect(saveA).toBeVisible();
  await expect(saveB).toBeVisible();
  await expect(page.getByRole("dialog").locator("article")).toHaveCount(2);
  page.on("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", {
      name: "保存できました（一時データを削除）",
      exact: true,
    })
    .first()
    .click();
  await expect(saveA).toHaveCount(0);
  await expect(saveB).toBeVisible();
  await durable(page);
  expect(await page.getByRole("dialog").locator("article").count()).toBe(1);
});

test("new session skips old media bytes and keeps archived work restorable", async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(source);
  await page.getByLabel("譜面名", { exact: true }).fill("ARCHIVED");
  await durable(page);
  await page.reload();
  await expect(page.getByRole("button", { name: /新しく作成（古い動画を読み込まない）/ })).toBeVisible({ timeout: 35000 });
  const loaded = await page.evaluate(() => {
    const global = window as typeof window & { __loadedAssets?: number };
    global.__loadedAssets = 0;
    const native = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === "assets") global.__loadedAssets!++;
      return native.call(this, key);
    };
    return global.__loadedAssets;
  });
  expect(loaded).toBe(0);
  await page.getByRole("button", { name: /新しく作成（古い動画を読み込まない）/ }).click();
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as typeof window & {
    __loadedAssets?: number;
  }).__loadedAssets)).toBe(0);
  await expect(page.getByRole("group", { name: /^素材 1/ })).toHaveCount(0);
  await durable(page);
  await page.reload();
  await page.getByRole("button", { name: /保存済みの作業を再開：ARCHIVED/ }).click();
  await expect(page.getByLabel("譜面名", { exact: true })).toHaveValue("ARCHIVED", {
    timeout: 35000,
  });
  await expect(page.getByRole("button", { name: "素材 1 のプレビューを読み込む" })).toBeVisible();
  await expect(page.locator('video[id^="local-media-"]')).toHaveCount(0);
  await page.getByRole("button", { name: "素材 1 のプレビューを読み込む" }).click();
  await expect(page.locator('video[id^="local-media-"]')).toHaveAttribute("src", /blob:/);
});
