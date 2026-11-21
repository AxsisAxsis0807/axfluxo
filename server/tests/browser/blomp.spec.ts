import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import type { BlompFile } from "../../../src/domain/blomp/storage";

const owner = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing fixture address");
  return `http://127.0.0.1:${address.port}`;
}
function close(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
const api = "https://blomp-api.test";
const signedPath = "/private-signed-fixture";
const original = Buffer.from("mock-media");

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const payloadHash = digest(original);

async function receiver(frontend: string, firstHtml = false) {
  const attempts: { size: number; sha256: string; status: number }[] = [];
  let preflights = 0;
  let writes = 0;
  const server = createServer(async (request, response) => {
    if (
      request.url !== signedPath ||
      request.headers.origin !== frontend ||
      request.headers.authorization !== undefined
    ) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader("access-control-allow-origin", frontend);
    response.setHeader("access-control-allow-methods", "PUT, GET, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");
    if (request.method === "OPTIONS") {
      if (request.headers["access-control-request-method"] !== "PUT") {
        response.writeHead(405).end();
        return;
      }
      preflights++;
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "video/mp4" }).end(original);
      return;
    }
    if (request.method !== "PUT") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > original.length) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      response.destroy();
      return;
    }
    const bytes = Buffer.concat(chunks);
    const sha256 = digest(bytes);
    const status =
      bytes.equals(original) && sha256 === payloadHash
        ? ++writes === 1
          ? firstHtml
            ? 200
            : 503
          : 200
        : 422;
    attempts.push({ size, sha256, status });
    if (firstHtml && writes === 1 && status === 200) {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<html>unconfirmed</html>");
      return;
    }
    response.writeHead(status).end();
  });
  const origin = await listen(server);
  return {
    origin,
    url: origin + signedPath,
    attempts,
    get writes() {
      return writes;
    },
    get preflights() {
      return preflights;
    },
    close: () => close(server),
  };
}

async function fixtureBundle(storageOrigin: string, completedExport = false) {
  const result = await build({
    stdin: {
      contents: `
        import {createRoot} from "react-dom/client";
        import Library from "./src/features/developer/BlompLibrary";
        import ExportDock from "./src/features/video-common/ExportDock";
        import {localExportQueue} from "./src/services/video/local-export-runtime";
        import {LOCK_KEY, SESSION_KEY} from "./src/services/developer/local-lock";
        if (${completedExport}) {
          localStorage.setItem(LOCK_KEY, JSON.stringify({salt:"0".repeat(32),hash:"0".repeat(64)}));
          sessionStorage.setItem(SESSION_KEY, String(Date.now()+60000));
          const blob = new Blob([Uint8Array.from(atob(${JSON.stringify(original.toString("base64"))}), char => char.charCodeAt(0))], {type:"video/mp4"});
          localExportQueue.restore([{id:"fixture-complete", filename:"test.mp4", state:"completed", progress:1, message:"", rest:false, result:{blob,filename:"test.mp4"}}]);
        }
        createRoot(document.getElementById("root")).render(<><Library />{${completedExport} && <ExportDock />}</>);
      `,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    jsx: "automatic",
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    plugins: [
      {
        name: "loopback-blomp-fixture",
        setup(build) {
          build.onLoad(
            { filter: /[\/]src[\/]services[\/]blomp[\/]client\.ts$/ },
            async ({ path }) => {
              const source = await readFile(path, "utf8");
              const expected = 'url.origin !== "https://storage.blomp.com"';
              if (source.split(expected).length !== 2)
                throw Error("Fixture expects one Blomp origin check");
              return {
                loader: "ts",
                contents: source.replace(
                  expected,
                  `url.origin !== ${JSON.stringify(storageOrigin)}`,
                ),
              };
            },
          );
        },
      },
    ],
    define: {
      "process.env.NODE_ENV": '"test"',
      "process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN": JSON.stringify(api),
      "process.env.NEXT_PUBLIC_SUPABASE_URL":
        '"https://blomp-fake.supabase.co"',
      "process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY":
        '"sb_publishable_axfluxo_blomp_fixture_dummy"',
    },
  });
  return result.outputFiles[0].text;
}

for (const firstHtml of [false, true]) {
  test(`interrupted direct transfer survives reload and verifies reselected bytes (${firstHtml ? "HTML" : "503"})`, async ({
    page,
  }) => {
    let file: BlompFile | undefined;
    const editor = createServer((request, response) => {
      if (request.method !== "GET" || request.url !== "/") {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "text/html" })
        .end('<!doctype html><div id="root"></div>');
    });
    const frontend = await listen(editor);
    const storage = await receiver(frontend, firstHtml).catch(async (error) => {
      await close(editor);
      throw error;
    });
    try {
      const bundle = await fixtureBundle(storage.origin, firstHtml);
      let signed = 0;
      let maxFileBytes: number | null = null;
      let starts = 0;
      let completes = 0;
      const resumed: string[] = [];
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(
        ({ owner }) => {
          localStorage.setItem(
            "axfluxo-auth",
            JSON.stringify({
              access_token: "private-fixture-token",
              refresh_token: "private-fixture-refresh",
              expires_at: Date.now() / 1000 + 3600,
              expires_in: 3600,
              token_type: "bearer",
              user: { id: owner },
            }),
          );
        },
        { owner },
      );
      await page.route(/^https?:\/\//, async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.href === frontend + "/") return route.continue();
        const headers = {
          "access-control-allow-origin": frontend,
          "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
          "access-control-allow-headers":
            "authorization,content-type,idempotency-key",
        };
        if (url.href === storage.url) return route.continue();
        if (url.origin !== api) return route.abort();
        if (request.method() === "OPTIONS")
          return route.fulfill({ status: 204, headers });
        expect(request.headers().authorization).toBe(
          "Bearer private-fixture-token",
        );
        const path = url.pathname;
        if (path.endsWith("/overview"))
          return route.fulfill({
            headers,
            json: {
              state: "available",
              capacity: 1000,
              capabilities: { multipartWrites: true, maxFileBytes },
              measuredUsed: 0,
              estimatedUsed: 0,
              available: 1000,
              reserved: 0,
              verifiedAt: null,
            },
          });
        if (path.endsWith("/files") && request.method() === "GET")
          return route.fulfill({
            headers,
            json: { files: file ? [file] : [], cursor: null },
          });
        if (path.endsWith("/files")) {
          starts++;
          const metadata = request.postDataJSON();
          expect(metadata.sha256).toBe(payloadHash);
          expect(metadata.size).toBe(original.length);
          expect(metadata.projectName).toBe("春の編集");
          expect(metadata.role).toBe(firstHtml ? "outputs" : "originals");
          const now = new Date().toISOString();
          file = {
            ...metadata,
            id,
            provider: "blomp",
            status: "queued",
            version: 1,
            createdAt: now,
            updatedAt: now,
            expiresAt: now,
          };
        } else if (path.endsWith("/resume")) {
          resumed.push(path.split("/").at(-2)!);
          file!.status = "uploading";
          return route.fulfill({
            headers,
            json: {
              file,
              parts:
                firstHtml && storage.writes
                  ? [{ number: 1, size: original.length }]
                  : [],
            },
          });
        } else if (path.endsWith("/part")) {
          signed++;
          return route.fulfill({
            headers,
            json: {
              url: storage.url,
              expiresAt: Date.now() + 60000,
            },
          });
        } else if (path.endsWith("/pause")) {
          file!.status = "interrupted";
        } else if (path.endsWith("/download")) {
          expect(path.split("/").at(-2)).toBe(id);
          return route.fulfill({
            headers,
            json: { url: storage.url, expiresAt: Date.now() + 60000 },
          });
        } else if (path.endsWith("/complete")) {
          expect(storage.writes).toBe(firstHtml ? 1 : 2);
          completes++;
          file!.status = "ready";
        }
        return route.fulfill({ headers, json: file });
      });
      async function open() {
        await page.addScriptTag({ content: bundle });
        await page.getByText("Blompストレージ", { exact: true }).click();
        await page.getByRole("button", { name: "状態と一覧を更新" }).click();
      }
      await page.goto(frontend);
      await page.setViewportSize({ width: 390, height: 844 });
      await open();
      await expect(
        page.getByRole("combobox", { name: "用途" }).locator("option"),
      ).toHaveText([
        "入力素材",
        "元素材",
        "途中データ",
        "チェックポイント",
        "完成品",
      ]);
      await expect(
        page.getByRole("heading", { name: "接続テスト" }),
      ).toBeVisible();
      const dock = page.getByRole("dialog", { name: "エクスポート管理" });
      const uploadPanel = firstHtml ? dock : page;
      if (firstHtml) {
        await page
          .locator('aside[aria-label="エクスポートミニバー"]')
          .getByRole("button")
          .click();
        await expect(
          dock.getByRole("link", { name: "test.mp4を保存" }),
        ).toBeVisible();
        await expect(dock.getByText(/用途 完成品/)).toBeVisible();
      }
      await uploadPanel.getByLabel("プロジェクト名（任意）").fill("春の編集");
      if (!firstHtml)
        await page.getByLabel("Blompへ保存するファイル").setInputFiles({
          name: "test.mp4",
          mimeType: "video/mp4",
          buffer: original,
        });
      await uploadPanel
        .getByRole("button", { name: "Blompに保存", exact: true })
        .click();
      await expect(
        page.getByText(
          "Blompの公式ファイル上限が未確認です。確認できるまでクラウド保存を保留します。",
        ),
      ).toBeVisible();
      expect(starts).toBe(0);
      expect(signed).toBe(0);
      expect(storage.writes).toBe(0);
      maxFileBytes = original.length - 1;
      await uploadPanel
        .getByRole("button", { name: "Blompに保存", exact: true })
        .click();
      await expect(
        page.getByText(
          "保存先のファイル上限を超えています。端末に保存するか、小さいファイルを選んでください。",
        ),
      ).toBeVisible();
      expect(starts).toBe(0);
      expect(signed).toBe(0);
      expect(storage.writes).toBe(0);
      maxFileBytes = original.length;
      await uploadPanel
        .getByRole("button", { name: "Blompに保存", exact: true })
        .click();
      await expect.poll(() => file?.status).toBe("interrupted");
      if (firstHtml)
        await expect(page.getByText(/パートの保存結果が未確認/)).toBeVisible();
      if (firstHtml)
        await expect(
          dock.getByRole("link", { name: "test.mp4を保存" }),
        ).toBeVisible();
      await page.reload();
      await open();
      const reselect = page.getByLabel("元ファイルを選び直す");
      await reselect.setInputFiles({
        name: "test.mp4",
        mimeType: "video/mp4",
        buffer: Buffer.alloc(original.length),
      });
      await page.getByRole("button", { name: "転送を再開" }).click();
      await expect(
        page.getByText("保存開始時と同じ元ファイルを選び直してください。"),
      ).toBeVisible();
      expect(signed).toBe(1);
      expect(storage.writes).toBe(1);
      expect(completes).toBe(0);
      await reselect.setInputFiles({
        name: "test.mp4",
        mimeType: "video/mp4",
        buffer: original,
      });
      await page.getByRole("button", { name: "転送を再開" }).click();
      await expect(
        page.getByRole("button", { name: "ダウンロードを準備" }),
      ).toBeVisible();
      const row = page.getByRole("listitem").filter({ hasText: "test.mp4" });
      await expect(row.getByText("春の編集", { exact: true })).toBeVisible();
      const roleLabel = firstHtml ? "完成品" : "元素材";
      await expect(row.getByText(roleLabel, { exact: true })).toBeVisible();
      await expect(row.locator("time")).toHaveAttribute(
        "datetime",
        file!.createdAt,
      );
      await row.getByRole("button", { name: "ダウンロードを準備" }).click();
      await expect(
        row.getByRole("link", {
          name: `${roleLabel}をダウンロード（SHA-256確認済み）`,
        }),
      ).toHaveAttribute("download", "test.mp4");
      expect(signed).toBe(firstHtml ? 1 : 2);
      expect(starts).toBe(1);
      expect(resumed).toEqual([id, id]);
      expect(completes).toBe(1);
      expect(storage.attempts).toEqual(
        (firstHtml ? [200] : [503, 200]).map((status) => ({
          size: original.length,
          sha256: payloadHash,
          status,
        })),
      );
      expect(
        await page.evaluate(() =>
          JSON.stringify([localStorage, sessionStorage]),
        ),
      ).not.toContain("private-signed-fixture");
      expect(errors).toEqual([]);
    } finally {
      await Promise.all([storage.close(), close(editor)]);
    }
  });
}

test("loopback receiver rejects missing and corrupted upload bytes", async () => {
  const frontend = "http://127.0.0.1";
  const storage = await receiver(frontend);
  try {
    const options = await fetch(storage.url, {
      method: "OPTIONS",
      headers: {
        origin: frontend,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type",
      },
    });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe(frontend);
    expect(options.headers.get("access-control-allow-methods")).toContain(
      "PUT",
    );
    expect(options.headers.get("access-control-allow-headers")).toBe(
      "content-type",
    );
    expect(storage.preflights).toBe(1);
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(original.length)]) {
      const response = await fetch(storage.url, {
        method: "PUT",
        headers: { origin: frontend },
        body: bytes,
      });
      expect(response.status).toBe(422);
    }
    expect(storage.attempts.map(({ size, status }) => [size, status])).toEqual([
      [0, 422],
      [original.length, 422],
    ]);
    const deniedHeaders: Record<string, string>[] = [
      { origin: "http://invalid.test" },
      { origin: frontend, authorization: "Bearer dummy" },
    ];
    for (const headers of deniedHeaders) {
      const denied = await fetch(storage.url, {
        method: "PUT",
        headers,
        body: original,
      });
      expect(denied.status).toBe(403);
    }
    expect(storage.writes).toBe(0);
  } finally {
    await storage.close();
  }
});
