import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  defaultFnfPreferences,
  type FnfPreferences,
  type FnfShowcaseSnapshot,
} from "../../../src/domain/video/fnf-showcase";
import { fnfOverlay } from "../../worker/templates/fnf-showcase/render";
let bundle: string, media: Buffer;
const owner = "11111111-1111-4111-8111-111111111111",
  asset = "22222222-2222-4222-8222-222222222222",
  version = "33333333-3333-4333-8333-333333333333",
  batchId = "44444444-4444-4444-8444-444444444444",
  hash = "a".repeat(64);
test.beforeAll(async () => {
  bundle = (
    await build({
      entryPoints: [
        new URL("fnf-showcase-fixture.tsx", import.meta.url).pathname,
      ],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env": "{}", "process.env.NODE_ENV": '"test"' },
    })
  ).outputFiles[0].text;
  const dir = await mkdtemp(join(tmpdir(), "fnf-browser-")),
    path = join(dir, "preview.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=30:duration=3",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-y",
      path,
    ],
    { stdio: "ignore" },
  );
  media = await readFile(path);
});
test("FNF draft ranges stay transient, local queue survives closure, and server submission is unavailable", async ({
  context,
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let prefs: FnfPreferences = defaultFnfPreferences(),
    prefRevision = 0,
    snapshot: FnfShowcaseSnapshot | null = null,
    cancels = 0;
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "authorization,content-type,idempotency-key,if-match,x-project-owner",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
  const jobs = () =>
    snapshot!.ranges.map((_, i) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i + 1).padStart(12, "0")}`,
      state: "queued",
      rangeIndex: i,
      attempt: 1,
      retryOf: null,
    }));
  const batch = () => ({
    id: batchId,
    ownerId: owner,
    jobs: jobs(),
    outputs: [],
  });
  await context.route("https://fnf-api.test/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (path.endsWith("/cancel")) cancels++;
    if (path === "/v1/developer/me") {
      await json({ ownerId: owner, membership: "developer" });
      return;
    }
    if (path === "/preferences/fnf-showcase") {
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        expect(Object.keys(body).sort()).toEqual([
          "schemaVersion",
          "template",
          "username",
        ]);
        expect(JSON.stringify(body)).not.toContain("DO_NOT_PERSIST");
        prefs = body;
        prefRevision++;
      }
      await json({ preferences: prefs, revision: prefRevision });
      return;
    }
    if (path === "/fnf-showcase/overlay") {
      const r = await fnfOverlay(req.postDataJSON());
      await json({ ...r, png: r.png.toString("base64") });
      return;
    }
    if (path.startsWith("/fnf-showcase/source/")) {
      await json({
        reference: {
          libraryId: "cloud",
          fileId: asset,
          versionId: version,
          hash,
          kind: "video",
        },
        durationUs: 3000000,
        width: 160,
        height: 90,
        geometryVerified: true,
      });
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
            name: "gameplay.mp4",
            deleted: false,
            versionId: version,
            hash,
            kind: "video",
            mime: "video/mp4",
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
          sourceTimeBase: "1/60000",
          proxyTimeBase: "1/1000000",
        },
        rate: { numerator: 30, denominator: 1 },
        rotationDegrees: 0,
        proxy: "https://fnf-media.test/preview.mp4",
        thumbnail: "https://fnf-media.test/thumbnail.png",
        waveform: "https://fnf-media.test/wave.json",
        expiresAt: Date.now() + 60000,
      });
      return;
    }
    if (path === "/fnf-showcase/batches") {
      if (req.method() === "POST") {
        if (req.postDataJSON().preferences.template.cropTop >= 90) {
          await json({ error: { code: "FNF_INVALID_CROP" } }, 422);
          return;
        }
        snapshot = req.postDataJSON();
        await json(batch(), 202);
      } else
        await json({
          items: snapshot
            ? [{ id: batchId, createdAt: "2026-11-02T00:00:00.000Z" }]
            : [],
          nextCursor: null,
        });
      return;
    }
    if (path === `/fnf-showcase/batches/${batchId}`) {
      await json({
        batch: batch(),
        items: snapshot!.ranges.map((r, i) => ({
          ...r,
          rangeIndex: i,
          chartName: snapshot!.chartNames[i],
          filename: snapshot!.names[i],
        })),
      });
      return;
    }
    if (path.endsWith("/progress")) {
      const job = jobs().find((j) => path.includes(j.id))!;
      await json({
        jobId: job.id,
        state: "queued",
        runs: 0,
        completedFrames: 0,
        totalFrames: 180,
        errorCode: null,
        retryAt: null,
      });
      return;
    }
    await json({ error: { code: "NOT_FOUND" } }, 404);
  });
  await context.route("https://fnf-media.test/**", async (route) => {
    if (route.request().url().includes(".mp4")) {
      await route.fulfill({ headers, contentType: "video/mp4", body: media });
      return;
    }
    if (route.request().url().includes(".json")) {
      await route.fulfill({
        headers,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          versionId: version,
          hash,
          originUs: 0,
          sampleRate: 8000,
          levels: [{ stepUs: 100000, peaks: [-0.5, 0.5] }],
        }),
      });
      return;
    }
    await route.fulfill({
      headers,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await context.route("https://fnf-browser.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ja"><div id="root"></div></html>',
    }),
  );
  await context.route("**/local-encoding/NotoSansJP.ttf", async (r) =>
    r.fulfill({
      body: await readFile(
        "server/worker/templates/fnf-showcase/assets/NotoSansJP.ttf",
      ),
    }),
  );
  async function start(p: typeof page) {
    await p.goto("https://fnf-browser.test/");
    await p.addScriptTag({ content: bundle });
  }
  await start(page);
  await page
    .getByText("クラウド素材を選択／upload（任意）", { exact: true })
    .click();
  await page.getByRole("button", { name: "使用：gameplay.mp4" }).click();
  await expect(page.getByLabel("range 1 終了", { exact: true })).toHaveValue(
    "00:00:03.000000",
  );
  await expect(page.getByRole("alert")).toContainText("固定presetと異なる");
  await page
    .getByRole("button", { name: "現在寸法で幅いっぱいに合わせる" })
    .click();
  await page
    .getByLabel("range 1 譜面名", { exact: true })
    .fill("DO_NOT_PERSIST_日本語");
  await page
    .getByRole("button", { name: "現在位置から30秒rangeを追加" })
    .click();
  await page
    .getByLabel("range 2 譜面名", { exact: true })
    .fill("DO_NOT_PERSIST_日本語");
  await expect(
    page.getByText("DO_NOT_PERSIST_日本語 (2).mp4", { exact: false }).first(),
  ).toBeVisible();
  await page.getByLabel("@username", { exact: true }).fill("@記憶する_user");
  await page.getByRole("button", { name: "template・usernameを保存" }).click();
  await expect(
    page.getByRole("status", { name: "設定保存状態" }),
  ).toContainText("端末／cloudに設定保存済み");
  const records = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const q = indexedDB.open("axfluxo-developer", 1);
      q.onsuccess = () => resolve(q.result);
    });
    const all = [];
    for (const name of Array.from(db.objectStoreNames))
      all.push(
        await new Promise((resolve) => {
          const q = db.transaction(name).objectStore(name).getAll();
          q.onsuccess = () => resolve(q.result);
        }),
      );
    db.close();
    return JSON.stringify({ all, localStorage: Object.entries(localStorage) });
  });
  expect(records).not.toContain("DO_NOT_PERSIST");
  expect(records).not.toContain("creationOrder");
  expect(records).not.toContain("test-token");
  await expect(
    page.getByRole("button", { name: "全rangeを一括受付" }),
  ).toHaveCount(0);
  await page.getByLabel("端末から元動画を読み込む").setInputFiles({
    name: "gameplay.mp4",
    mimeType: "video/mp4",
    buffer: media,
  });
  await page
    .getByLabel("range 1 譜面名", { exact: true })
    .fill("LOCAL_QUEUE_日本語");
  await page
    .getByRole("button", { name: "現在の編集内容をキューに追加" })
    .click();
  await expect(page.getByLabel("Local Low-Load Encoding")).toContainText(
    "LOCAL_QUEUE_日本語.mp4",
  );
  expect(snapshot).toBeNull();
  await page.close();
  const next = await context.newPage();
  next.on("pageerror", (e) => errors.push(e.message));
  await start(next);
  await expect(next.getByLabel("@username", { exact: true })).toHaveValue(
    "@記憶する_user",
  );
  expect(await next.getByLabel("range 1 譜面名", { exact: true }).count()).toBe(
    0,
  );
  await expect(next.getByLabel("Local Low-Load Encoding")).toContainText(
    "LOCAL_QUEUE_日本語.mp4",
  );
  await next
    .getByText("クラウド素材を選択／upload（任意）", { exact: true })
    .click();
  await next.getByRole("button", { name: "使用：gameplay.mp4" }).click();
  await expect(next.getByLabel("range 1 譜面名", { exact: true })).toHaveValue(
    "",
  );
  expect(await next.getByLabel("range 2 譜面名", { exact: true }).count()).toBe(
    0,
  );
  expect(cancels).toBe(0);
  expect(errors).toEqual([]);
});

test("FNF rejects local editing and queue access without server developer membership", async ({
  page,
}) => {
  await page.route("https://fnf-api.test/**", (r) =>
    r.fulfill({
      status: 403,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization",
      },
      body: JSON.stringify({ code: "FORBIDDEN" }),
    }),
  );
  await page.route("https://fnf-browser.test/", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("https://fnf-browser.test/");
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("status")).toContainText("HTTP_403");
  await expect(page.getByLabel("端末から元動画を読み込む")).toHaveCount(0);
  await expect(page.getByLabel("Local Low-Load Encoding")).toHaveCount(0);
});
