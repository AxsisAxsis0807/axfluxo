import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let bundle: string, source: string;
test.beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "recovery-"));
  source = join(dir, "source.mp4");
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
      define: { "process.env.NODE_ENV": '"test"' },
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
  await page.goto("https://recovery.test/fnf");
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled({
    timeout: 35000,
  });
}
async function resumeSaved(page: Page) {
  await page.getByRole("button", { name: /前回の作業を再開/ }).click();
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
      [
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type:packet=stream_index,pts_time,duration_time",
        "-of",
        "json",
        path,
      ],
      { encoding: "utf8" },
    ),
  );
  const tracks: {
    index: number;
    codec_type: string;
  }[] = probe.streams;
  const packets: {
    stream_index: number;
    pts_time?: string;
    duration_time?: string;
  }[] = probe.packets;
  const duration = (kind: string) => {
    const track = tracks.find((entry) => entry.codec_type === kind);
    const timestamps = packets
      .filter((packet) => packet.stream_index === track?.index)
      .flatMap((packet) => {
        const start = Number(packet.pts_time);
        const length = Number(packet.duration_time ?? 0);
        return Number.isFinite(start) && Number.isFinite(length)
          ? [{ start, end: start + length }]
          : [];
      });
    expect(timestamps.length).toBeGreaterThan(1);
    return (
      Math.max(...timestamps.map(({ end }) => end)) -
      Math.min(...timestamps.map(({ start }) => start))
    );
  };
  expect(duration("video")).toBeGreaterThanOrEqual(0.85);
  expect(Math.abs(duration("video") - duration("audio"))).toBeLessThanOrEqual(
    0.4,
  );
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
  await expect(page.getByRole("button", { name: /新しく作成（古い動画を読み込まない）/ })).toBeVisible();
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
  expect(await page.locator("video").first().getAttribute("src")).toBeNull();
  await page.getByRole("button", { name: "素材 1 のプレビューを読み込む" }).click();
  await expect(page.locator("video").first()).toHaveAttribute("src", /blob:/);
});
