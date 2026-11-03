import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { textImage } from "../../worker/templates/all-versions/graphics";
import type { AllVersionsProject } from "../../../src/domain/video/all-versions";
let bundle: string, media: Buffer;
const owner = "11111111-1111-4111-8111-111111111111",
  asset = "22222222-2222-4222-8222-222222222222",
  version = "33333333-3333-4333-8333-333333333333",
  image = "44444444-4444-4444-8444-444444444444",
  imageVersion = "55555555-5555-4555-8555-555555555555",
  hash = "a".repeat(64);
test.beforeAll(async () => {
  const r = await build({
    entryPoints: [
      new URL("all-versions-fixture.tsx", import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"test"' },
  });
  bundle = r.outputFiles[0].text;
  const dir = await mkdtemp(join(tmpdir(), "av-browser-")),
    path = join(dir, "preview.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=black:size=160x90:rate=30:duration=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=3",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-c:a",
      "aac",
      "-y",
      path,
    ],
    { stdio: "ignore" },
  );
  media = await readFile(path);
});
test("six-step editor keeps names, saves offline, synchronizes revisions, and uses local text PNG", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let saved: AllVersionsProject | null = null,
    revision = 0,
    texts = 0;
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "authorization,content-type,idempotency-key,if-match,x-project-owner",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
  await page.route("https://av-api.test/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const json = async (body: unknown, status = 200) =>
      route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/v1/developer/me") {
      await json({ ownerId: owner, membership: "developer" });
      return;
    }
    if (path === "/cloud/folders") {
      await json({ items: [], nextCursor: null });
      return;
    }
    if (path === "/cloud/assets") {
      await json({
        items: [
          {
            id: asset,
            folderId: null,
            name: "song.wav",
            deleted: false,
            versionId: version,
            hash,
            kind: "audio",
            mime: "audio/wav",
            size: 100,
          },
          {
            id: image,
            folderId: null,
            name: "cover.png",
            deleted: false,
            versionId: imageVersion,
            hash,
            kind: "image",
            mime: "image/png",
            size: 100,
          },
        ],
        nextCursor: null,
      });
      return;
    }
    if (path.endsWith("/preview")) {
      await json({
        versionId: version,
        assetId: asset,
        hash,
        durationUs: 3000000,
        width: 160,
        height: 90,
        mapping: {
          sourceFirstPtsUs: 0,
          proxyFirstPtsUs: 0,
          sourceTimeBase: "1/48000",
          proxyTimeBase: "1/1000000",
        },
        rate: { numerator: 30, denominator: 1 },
        rotationDegrees: 0,
        proxy: "https://av-media.test/preview.mp4",
        thumbnail: "https://av-media.test/cover.png",
        waveform: "https://av-media.test/wave.json",
        expiresAt: Date.now() + 60000,
      });
      return;
    }
    if (path.endsWith("/access")) {
      await json({
        url: "https://av-media.test/cover.png",
        expiresAt: Date.now() + 60000,
      });
      return;
    }
    if (path === "/projects/text-preview") {
      const b = req.postDataJSON();
      try {
        const result = await textImage(b.project, b.index);
        texts++;
        await json({ ...result, png: result.png.toString("base64") });
      } catch {
        await json({ error: { code: "FONT_GLYPH_UNSUPPORTED" } }, 422);
      }
      return;
    }
    if (path.startsWith("/projects/")) {
      if (req.method() === "GET") {
        await json({ project: saved, revision });
        return;
      }
      const expected = Number(req.headers()["if-match"]?.replaceAll('"', ""));
      if (expected !== revision) {
        await json(
          { error: { code: "PROJECT_CONFLICT" }, project: saved, revision },
          409,
        );
        return;
      }
      saved = req.postDataJSON();
      revision++;
      await json({ project: saved, revision });
      return;
    }
    await json({ error: { code: "NOT_FOUND" } }, 404);
  });
  await page.route("https://av-media.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(".mp4")) {
      await route.fulfill({
        headers: { ...headers, "accept-ranges": "bytes" },
        contentType: "video/mp4",
        body: media,
      });
    } else if (path.endsWith(".json"))
      await route.fulfill({
        headers,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          versionId: version,
          hash,
          originUs: 0,
          sampleRate: 8000,
          levels: [
            {
              stepUs: 100000,
              peaks: Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.5 : -0.5)),
            },
          ],
        }),
      });
    else
      await route.fulfill({
        headers,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      });
  });
  await page.route("https://all-versions-browser.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ja"><div id="root"></div></html>',
    }),
  );
  await page.route("**/local-encoding/Aleo.ttf", async (r) =>
    r.fulfill({
      body: await readFile(
        "server/worker/templates/all-versions/assets/Aleo.ttf",
      ),
    }),
  );
  await page.goto("https://all-versions-browser.test/");
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "使用：song.wav" }).click();
  await page.getByRole("button", { name: "使用：cover.png" }).click();
  await page.getByRole("button", { name: "2. 音声編集" }).click();
  const current = page.getByLabel("現在時刻");
  await current.fill("1.000000");
  await current.press("Enter");
  await page.getByRole("button", { name: "現在位置にmarkerを追加" }).click();
  await page.getByRole("button", { name: "3. 名前" }).click();
  const names = page.getByLabel("version名（1行につき1つ）");
  await names.fill("1. One\n\n2. Two");
  await expect(page.getByLabel("検出事項")).toContainText("空行");
  await expect(names).toHaveValue("1. One\n\n2. Two");
  await names.fill("1. One\n2. Two");
  await page.getByLabel("先頭番号を除去").check();
  await expect(names).toHaveValue("1. One\n2. Two");
  await page.getByRole("button", { name: "4. デザイン" }).click();
  await page.getByLabel("出力解像度").selectOption("1440");
  await page.getByRole("button", { name: "手動保存・同期" }).click();
  await expect(page.getByRole("status", { name: "保存状態" })).toContainText(
    "cloudに保存済み",
  );
  expect((saved as AllVersionsProject | null)?.design.height).toBe(1440);
  await page.getByRole("button", { name: "5. 全長preview" }).click();
  await expect(page.getByAltText("端末内生成の文字")).toBeVisible();
  expect(texts).toBe(0);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    }),
  );
  await page.getByRole("button", { name: "3. 名前" }).click();
  await names.fill("Offline One\nOffline Two");
  await page.getByRole("button", { name: "端末保存を確定" }).click();
  await expect(page.getByRole("status", { name: "保存状態" })).toContainText(
    "端末に保存済み",
  );
  expect((saved as AllVersionsProject | null)?.namesText).toBe(
    "1. One\n2. Two",
  );
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const q = indexedDB.open("axfluxo-developer", 1);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    const rows = await new Promise<unknown[]>((resolve) => {
      const q = db.transaction("documents").objectStore("documents").getAll();
      q.onsuccess = () => resolve(q.result);
    });
    db.close();
    return rows;
  });
  expect(JSON.stringify(stored)).toContain("Offline One");
  expect(JSON.stringify(stored)).not.toContain("test-token");
  expect(errors).toEqual([]);
});

test("All Versions denies local media and export controls when server membership rejects access", async ({
  page,
}) => {
  await page.route("https://av-api.test/**", (r) =>
    r.fulfill({
      status: 403,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization",
      },
      body: JSON.stringify({ code: "FORBIDDEN" }),
    }),
  );
  await page.route("https://all-versions-browser.test/", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("https://all-versions-browser.test/");
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("status")).toContainText("HTTP_403");
  await expect(
    page.getByLabel("端末から音声・動画・カバーアートを読み込む"),
  ).toHaveCount(0);
  await expect(page.getByLabel("Local Low-Load Encoding")).toHaveCount(0);
});
