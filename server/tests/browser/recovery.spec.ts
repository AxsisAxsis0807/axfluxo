import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
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
async function assertBlankEditor(page: Page) {
  await expect(page.getByLabel("端末の素材", { exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: /前回の作業を再開|保存済みの作業を再開|新しく作成/ })).toHaveCount(0);
  await expect(page.getByTestId("local-save-status")).toHaveCount(0);
  await expect(page.getByRole("group", { name: /^素材 1/ })).toHaveCount(0);
  await expect(page.getByRole("article", { name: /^音源 1$/ })).toHaveCount(0);
}
async function durable(page: Page) {
  await page.evaluate(async () => {
    await (window as unknown as { flushExportRecovery: () => Promise<void> }).flushExportRecovery();
  });
}
async function inventory(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("axfluxo.local-video-recovery");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await Promise.all(["projects", "assets", "jobs"].map((name) =>
        new Promise<IDBValidKey[]>((resolve, reject) => {
          const request = db.transaction(name).objectStore(name).getAllKeys();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }),
      ));
    } finally {
      db.close();
    }
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
  await assertBlankEditor(page);
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(source);
  await page.getByLabel("譜面名", { exact: true }).fill("EDITING WHILE STALLED");
  const retry = page.getByRole("button", { name: "書き出しデータの復旧を再試行" });
  await expect(retry).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText(/保存済みデータは削除していません/).first()).toBeVisible();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(page.getByLabel("譜面名", { exact: true })).toHaveValue("EDITING WHILE STALLED");
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
  await expect(page.getByRole("article", { name: "音源 1", exact: true })).toContainText("tone.mp3");
  await fallback.setInputFiles(mp3);
  await expect(page.getByRole("article", { name: "音源 2", exact: true })).toContainText("tone.mp3");
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
  await expect(page.getByRole("article", { name: "音源 2", exact: true })).toContainText("source.mp4");
  const trim = (index: number) => page.getByRole("article", { name: `音源 ${index}` })
    .getByRole("button", { name: "切り取り", exact: true });
  await trim(1).click();
  const active = page.locator('audio[id^="local-media-"]');
  await expect(active).toHaveCount(1);
  await expect(page.locator('video[id^="local-media-"]')).toHaveCount(0);
  const first = await active.getAttribute("id");
  expect(await active.getAttribute("preload")).toBe("metadata");
  await trim(2).click();
  await page.getByRole("button", { name: "素材 2 のプレビューを読み込む" }).click();
  await expect(active).toHaveCount(1);
  expect(await active.getAttribute("id")).not.toBe(first);
  await page.getByRole("button", { name: "素材 2 のプレビューを閉じる" }).click();
  await expect(active).toHaveCount(0);
  await expect(page.getByRole("article", { name: "音源 1", exact: true })).toContainText("source.mp4");
  await expect(page.getByRole("article", { name: "音源 2", exact: true })).toContainText("source.mp4");
});
test("All Versions composition uses audio-only playback and a cover canvas", async ({
  page,
}) => {
  test.setTimeout(90000);
  await open(page);
  await page.goto("https://recovery.test/all");
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(source);
  await page.getByLabel("バージョン名（改行区切り）").fill("ONE");
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
for (const method of ["fill", "keys"] as const) {
test(`FNF edits stay in the page and its explicit template survives reload (${method})`, async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const events: unknown[] = [];
  const stages: unknown[] = [];
  await page.exposeFunction("recordFNFInputEvent", (event: unknown) => { events.push(event); });
  await page.addInitScript(() => {
    for (const type of ["beforeinput", "input", "change", "focusin", "focusout", "keydown", "keyup"]) {
      document.addEventListener(type, e => {
        const el = e.target;
        if (!(el instanceof HTMLInputElement) || el.type === "file") return;
        void (window as unknown as { recordFNFInputEvent: (event: unknown) => Promise<void> }).recordFNFInputEvent({ type, time: performance.now(), trusted: e.isTrusted, value: el.value, attribute: el.getAttribute("value"), inputType: (e as InputEvent).inputType, label: el.closest("label")?.textContent });
      }, true);
    }
  });
  const chartName = page.getByLabel("譜面名", { exact: true });
  async function checkpoint(stage: string) {
    stages.push({ stage, ...await chartName.evaluate(el => ({ time: performance.now(), value: (el as HTMLInputElement).value, attribute: el.getAttribute("value") })) });
    await expect(chartName, stage).toHaveValue("RESTORED");
    // React renders the controlled value attribute from state as well as the live DOM value.
    await expect(chartName, stage + " controlled value").toHaveAttribute("value", "RESTORED");
  }
  try {
  await open(page);
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(source);
  if (method === "fill") await chartName.fill("RESTORED");
  else await chartName.pressSequentially("RESTORED");
  await checkpoint("after name input");
  await page
    .getByRole("button", { name: "中央に手動マーカー追加", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Smart Track Boundary Detection" })
      .locator("li"),
  ).toContainText("manual");
  await checkpoint("after marker");
  await page.getByLabel("開始秒", { exact: true }).fill("0.5");
  await checkpoint("after start");
  await page.getByLabel("終了秒", { exact: true }).fill("2");
  await checkpoint("after end");
  await page.getByRole("button", { name: "拡大", exact: true }).click();
  await checkpoint("after zoom");
  await page.getByRole("button", { name: "テンプレートを端末に保存" }).click();
  const savedName = await page.evaluate(() => JSON.parse(localStorage.getItem("axfluxo.local-video-template.fnf-showcase") ?? "null")?.ranges?.[0]?.name);
  expect(savedName).toBe("RESTORED");
  expect(await inventory(page)).toEqual([[], [], []]);
  await page.reload();
  await assertBlankEditor(page);
  await expect(page.getByLabel("譜面名", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "端末のテンプレートを読み込む" }).click();
  await expect(page.getByLabel("譜面名", { exact: true })).toHaveValue("RESTORED");
  await expect(page.getByLabel("開始秒", { exact: true })).toHaveValue("0.5");
  await expect(page.getByLabel("終了秒", { exact: true })).toHaveValue("2");
  expect(await inventory(page)).toEqual([[], [], []]);
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
  } finally {
    await info.attach("fnf-input-diagnostics", { body: JSON.stringify({ method, project: info.project.name, stages, events }, null, 2), contentType: "application/json" });
  }
});
}
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
  await expect(page.getByLabel("譜面名", { exact: true }).first()).toHaveValue("A");
  await expect(page.getByLabel("譜面名", { exact: true }).nth(1)).toHaveValue("B");
  await expect(page.getByLabel("終了秒", { exact: true }).first()).toHaveValue("1.2");
  await expect(page.getByLabel("終了秒", { exact: true }).nth(1)).toHaveValue("1.5");
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
      page.getByRole("region", { name: "端末内書き出し" }).getByRole("status"),
    ).toContainText(/このブラウザーは端末内エンコードに対応していません|Canvasの動画書き出しに対応していません/);
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
    await assertBlankEditor(page);
    expect(await inventory(page)).toEqual([[], [], []]);
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
  await page.getByLabel("譜面名", { exact: true }).first().fill("CHANGED AFTER RESERVATION");
  await durable(page);
  await page.reload();
  await assertBlankEditor(page);
  await page.getByRole("button", { name: /詳細を開く/ }).click({ timeout: 35000 });
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
  await assertBlankEditor(page);
  await page.getByRole("button", { name: /詳細を開く/ }).click({ timeout: 35000 });
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

test("new session does not read or delete archived media", async ({ page }) => {
  await open(page);
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(source);
  await page.getByLabel("譜面名", { exact: true }).fill("ARCHIVED");
  await expect(page.getByLabel("譜面名", { exact: true })).toHaveValue("ARCHIVED");
  await page.evaluate(() => (window as unknown as { seedLegacyData: (finished: boolean) => Promise<void> }).seedLegacyData(false));
  const archived = await inventory(page);
  expect(archived[0]).toEqual(["fnf-showcase:legacy-fixture"]);
  expect(archived[1].length).toBeGreaterThan(1);
  await page.addInitScript(() => {
    const state = window as typeof window & { assetReads?: number };
    state.assetReads = 0;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === "assets") state.assetReads!++;
      return get.call(this, key);
    };
  });
  await page.reload();
  await assertBlankEditor(page);
  expect(await inventory(page)).toEqual(archived);
  expect(await page.evaluate(() => (window as typeof window & { assetReads?: number }).assetReads)).toBe(0);
});

test("reload during lease renewal keeps archived work restorable", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const state = window as typeof window & { reloadAtLease?: boolean; assetReads?: string[]; jobWrites?: number };
    state.assetReads = [];
    state.jobWrites = 0;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === "assets") state.assetReads!.push(String(key));
      return get.call(this, key);
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      const result = put.call(this, value, key);
      if (this.name === "jobs") state.jobWrites!++;
      if (state.reloadAtLease && this.name === "meta" && key === "lease" &&
          this.transaction.objectStoreNames.length === 1) {
        state.reloadAtLease = false;
        sessionStorage.setItem("lease-reload-observed", "yes");
        location.reload();
      }
      return result;
    };
  });
  await open(page);
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(source);
  const chart = page.getByLabel("譜面名", { exact: true });
  await chart.fill("ARCHIVED");
  await expect(chart).toHaveValue("ARCHIVED");
  await page.evaluate(() => (window as unknown as { seedLegacyData: (finished: boolean) => Promise<void> }).seedLegacyData(true));
  await expect(chart).toHaveValue("ARCHIVED");
  const before = await inventory(page);
  const navigation = page.waitForEvent("framenavigated", {
    predicate: (frame) => frame === page.mainFrame(), timeout: 15000,
  });
  await page.evaluate(() => {
    const state = window as unknown as { reloadAtLease?: boolean; renewRecoveryLease: () => Promise<void> };
    state.reloadAtLease = true;
    void state.renewRecoveryLease();
  });
  await navigation;
  await assertBlankEditor(page);
  expect(await page.evaluate(() => sessionStorage.getItem("lease-reload-observed"))).toBe("yes");
  await page.getByRole("button", { name: /詳細を開く/ }).click({ timeout: 35000 });
  const save = page.getByRole("link", { name: "LEGACY.mp4を保存" });
  await expect(save).toBeVisible();
  const download = page.waitForEvent("download");
  await save.click();
  expect(await (await download).failure()).toBeNull();
  expect(await inventory(page)).toEqual(before);
  const reads = await page.evaluate(() => (window as typeof window & { assetReads?: string[] }).assetReads);
  expect(reads?.some((key) => key.includes("output:legacy-output"))).toBe(true);
  expect(reads?.some((key) => key.includes("legacy-fixture"))).toBe(false);
  await durable(page);
  expect(await page.evaluate(() => (window as typeof window & { jobWrites?: number }).jobWrites)).toBe(0);
});

test("All Versions mobile cards keep names and trim attached to each reordered file", async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.goto("https://recovery.test/all");
  const css = await readFile("src/app/globals.css", "utf8");
  await page.addStyleTag({ content: css.replace(/^@import[^;]+;/, "") });

  const picker = page.getByLabel("端末の素材", { exact: true });
  await expect(picker).toBeEnabled({ timeout: 35_000 });
  const title = page.getByLabel("曲名", { exact: true });
  const names = page.getByLabel("バージョン名（改行区切り）");
  const card = (index: number) => page.getByRole("article", { name: `音源 ${index}`, exact: true });
  const trim = (index: number) => card(index).getByRole("button", { name: "切り取り", exact: true });
  const move = (index: number, direction: "上" | "下") =>
    card(index).getByRole("button", { name: `音源 ${index} を${direction}へ移動` });
  const song = "BROS SUCH A DIGGER FUNK";
  const versions = ["Original", "Slowed", "Super Slowed", "Over Slowed"];
  const buffer = await readFile(mp3);
  await picker.setInputFiles(versions.map((version, index) => ({
    name: `${song}${index ? ` - ${version}` : ""}.mp3`,
    mimeType: "audio/mpeg",
    buffer,
  })));
  await title.fill(song);
  await names.fill(versions.join("\n"));
  await expect(card(4)).toContainText("Over Slowed");
  await expect(move(1, "上")).toBeDisabled();
  await expect(move(4, "下")).toBeDisabled();
  await expect(page.getByLabel("開始秒", { exact: true })).toHaveCount(0);
  await expect(page.locator('audio[id^="local-media-"]')).toHaveCount(0);
  await expect(page.getByText("曲間", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1秒（固定）", { exact: true })).toHaveCount(0);
  await names.blur();
  await page.getByRole("region", { name: "基本情報" }).screenshot({
    path: info.outputPath("all-versions-mobile.png"),
  });
  await title.fill(song.repeat(8));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await title.fill(song);

  await trim(2).click();
  await expect(trim(2)).toHaveAttribute("aria-expanded", "true");
  await card(2).getByLabel("開始秒", { exact: true }).fill("0.25");
  await trim(2).click();
  await names.fill(versions.slice(0, 2).join("\n"));
  await move(2, "上").click();
  await move(1, "下").click();
  await move(2, "下").click();
  await expect(names).toHaveValue("Original\n\nSlowed");
  await expect(card(3)).toContainText(`${song} - Slowed.mp3`);
  await expect(trim(3)).toHaveAttribute("aria-expanded", "false");
  await trim(3).click();
  await expect(card(3).getByLabel("開始秒", { exact: true })).toHaveValue("0.25");

  await trim(3).click();
  await trim(3).click();
  await expect(card(3).getByLabel("開始秒", { exact: true })).toHaveValue("0.25");
  await card(3).getByRole("button", { name: "素材を外す" }).click();
  await expect(page.getByRole("region", { name: "音源管理・並べ替え" })).toContainText("3曲");
  await expect(card(3)).toContainText(`${song} - Over Slowed.mp3`);
  const longFile = `${"longFilename".repeat(16)}.mp3`;
  await picker.setInputFiles({ name: longFile, mimeType: "audio/mpeg", buffer });
  await expect(card(4)).toContainText(longFile);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole("button", { name: "テンプレートを端末に保存" }).click();
  expect(await inventory(page)).toEqual([[], [], []]);
  await page.reload();
  await assertBlankEditor(page);
  await expect(title).toHaveValue("");
  await expect(names).toHaveValue("");
  await page.getByRole("button", { name: "端末のテンプレートを読み込む" }).click();
  await expect(title).toHaveValue(song);

});

test("a blocked reservation never reports success before storage commits", async ({ page }) => {
  await open(page);
  await page.goto("https://recovery.test/all");
  await page.getByLabel("端末の素材", { exact: true }).setInputFiles(mp3);
  await page.getByLabel("カバー画像").setInputFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Yp8AAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const title = page.getByLabel("曲名", { exact: true });
  await title.fill("NO SPACE");
  await page.getByLabel("バージョン名（改行区切り）").fill("Original");
  await page.evaluate(() => {
    const state = window as unknown as {
      denyReservation?: () => void;
      localExportQueue: { pause: () => void };
    };
    state.localExportQueue.pause();
    // Install the controlled StorageManager on the navigator itself so its
    // estimator survives WebKit's native-wrapper lifetime.
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: () => new Promise<StorageEstimate>((resolve) => {
          state.denyReservation = () => resolve({ quota: 1, usage: 1 });
        }),
      },
    });
  });
  await page.getByRole("button", { name: "端末内で書き出す", exact: true }).click();
  const exports = page.getByRole("region", { name: "端末内書き出し" });
  await expect.poll(async () => {
    const hook = await page.evaluate(() => typeof (window as typeof window & { denyReservation?: () => void }).denyReservation);
    const message = await exports.getByRole("status").textContent();
    return `${hook}: ${message}`;
  }).toMatch(/^function:/);
  await expect(page.getByText("現在の設定で予約しました。", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "エクスポートミニバー" })).toHaveCount(0);
  await title.fill("EDITABLE");
  await page.evaluate(() =>
    (window as typeof window & { denyReservation?: () => void }).denyReservation?.(),
  );
  await expect(exports.getByRole("status")).toContainText("保存容量が不足");
  await expect(title).toHaveValue("EDITABLE");
  expect(await inventory(page)).toEqual([[], [], []]);
  const queueCount = () => page.evaluate(() => (window as unknown as { localExportQueue: { getSnapshot: () => { entries: unknown[] } } }).localExportQueue.getSnapshot().entries.length);
  expect(await queueCount()).toBe(0);
  // A storage retry must not silently resurrect a reservation rejected above.
  await page.evaluate(() => Object.defineProperty(navigator, "storage", { configurable: true, value: { estimate: async () => ({ quota: 1024 ** 3, usage: 0 }) } }));
  await page.getByRole("button", { name: "書き出しデータの復旧を再試行" }).click();
  await expect(page.getByRole("region", { name: "書き出しデータの復旧" })).toHaveCount(0);
  expect(await queueCount()).toBe(0);
  expect(await inventory(page)).toEqual([[], [], []]);
  // A new explicit reservation uses the current editor, not the rejected one.
  await page.getByRole("button", { name: "端末内で書き出す", exact: true }).click();
  await expect(exports.getByRole("status")).toContainText("現在の設定で予約しました。");
  expect(await queueCount()).toBe(3);
  expect((await inventory(page))[2]).toHaveLength(3);
});

test("one All Versions reservation keeps the full mix, short, and each version independent after reload", async ({ page }) => {
  await open(page);
  await page.goto("https://recovery.test/all");
  const pick = page.getByLabel("端末の素材", { exact: true });
  const buffer = await readFile(mp3);
  await pick.setInputFiles(["one.mp3", "two.mp3"].map(name => ({ name, mimeType: "audio/mpeg", buffer })));
  await page.getByLabel("曲名", { exact: true }).fill("Mix - 東京");
  await page.getByLabel("カバー画像").setInputFiles({
    name: "cover.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Yp8AAAAASUVORK5CYII=", "base64"),
  });
  const first = page.getByRole("article", { name: "音源 1", exact: true });
  await first.getByRole("button", { name: "切り取り", exact: true }).click();
  await first.getByLabel("version境界（素材内の秒、カンマ区切り）").fill("1");
  await page.getByLabel("バージョン名（改行区切り）").fill("(Normal)\n(Second)\n(Alternate)");
  const second = page.getByRole("article", { name: "音源 2", exact: true });
  await second.getByRole("button", { name: "切り取り", exact: true }).click();
  await second.getByLabel("終了秒", { exact: true }).fill("1.75");
  await second.getByRole("button", { name: "この音源をショートに使う" }).click();
  await second.getByLabel("開始秒", { exact: true }).fill("0.25");
  await second.getByLabel("終了秒", { exact: true }).fill("1.5");
  await second.getByLabel("編集する範囲").selectOption("all-versions");
  await expect(second.getByLabel("終了秒", { exact: true })).toHaveValue("1.75");
  await page.evaluate(() =>
    (window as unknown as { localExportQueue: { pause: () => void } }).localExportQueue.pause(),
  );
  await page.getByRole("button", { name: "端末内で書き出す", exact: true }).click();
  await expect(page.getByRole("region", { name: "端末内書き出し" }).getByRole("status"))
    .toContainText("現在の設定で予約しました。");
  await page.getByLabel("曲名", { exact: true }).fill("Changed after reservation");
  const inspect = () => page.evaluate(() =>
    (window as unknown as { localExportQueue: { getSnapshot: () => { entries: {
      input?: import("../../../src/services/video/local-encode").LocalEncodeJob;
    }[] } } }).localExportQueue.getSnapshot().entries.map(({ input }) => ({
      width: input?.width,
      height: input?.height,
      title: input?.recovery?.project.musicShowcase?.title,
      ranges: input?.pieces.map(p => [p.file?.name, p.start, p.end]),
    })),
  );
  const reserved = await inspect();
  expect(reserved.map(job => [job.width, job.height])).toEqual([
    [1920, 1080], [1080, 1920], [1920, 1080], [1920, 1080], [1920, 1080],
  ]);
  expect(reserved.map(job => job.title)).toEqual(Array(5).fill("Mix - 東京"));
  expect(reserved[1].ranges).toEqual([["two.mp3", 0.25, 1.5]]);
  expect(reserved[2].ranges).toEqual([["one.mp3", 0, 1]]);
  expect(reserved[3].ranges?.[0]?.slice(0, 2)).toEqual(["one.mp3", 1]);
  expect(reserved[4].ranges).toEqual([["two.mp3", 0, 1.75]]);
  await durable(page);
  // Disable real encoding in the reloading page until we verify the recipes.
  await page.addInitScript(() => Object.defineProperty(window, "VideoEncoder", { value: undefined, configurable: true }));
  await page.reload();
  await expect.poll(async () => (await inspect()).length, { timeout: 20_000 }).toBe(5);
  expect(await inspect()).toEqual(reserved);
});
