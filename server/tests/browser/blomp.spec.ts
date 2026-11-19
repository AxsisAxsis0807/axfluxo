import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import type { BlompFile } from "../../../src/domain/blomp/storage";

let bundle = "";
const owner = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const frontend = "https://blomp-editor.test";
const api = "https://blomp-api.test";
const storage = "https://storage.blomp.com";
const original = Buffer.from("mock-media");

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents:
        'import {createRoot} from "react-dom/client"; import Library from "./src/features/developer/BlompLibrary"; createRoot(document.getElementById("root")).render(<Library />);',
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    jsx: "automatic",
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    define: {
      "process.env.NODE_ENV": '"test"',
      "process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN": JSON.stringify(api),
      "process.env.NEXT_PUBLIC_SUPABASE_URL":
        '"https://blomp-fake.supabase.co"',
      "process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY":
        '"sb_publishable_axfluxo_blomp_fixture_dummy"',
    },
  });
  bundle = result.outputFiles[0].text;
});

test("interrupted direct transfer survives reload and verifies reselected bytes", async ({
  page,
}) => {
  let file: BlompFile | undefined;
  let writes = 0;
  let signed = 0;
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
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === frontend)
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><div id="root"></div>',
      });
    const headers = {
      "access-control-allow-origin": frontend,
      "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
      "access-control-allow-headers":
        "authorization,content-type,idempotency-key",
    };
    if (url.origin !== api && url.origin !== storage) return route.abort();
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    if (url.origin === storage) {
      expect(request.method()).toBe("PUT");
      expect(request.headers().authorization).toBeUndefined();
      expect(request.postDataBuffer()).toEqual(original);
      return route.fulfill({ status: ++writes === 1 ? 503 : 200, headers });
    }
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
      const now = new Date().toISOString();
      file = {
        ...request.postDataJSON(),
        id,
        provider: "blomp",
        status: "queued",
        version: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt: now,
      };
    } else if (path.endsWith("/resume")) {
      file!.status = "uploading";
      return route.fulfill({ headers, json: { file, parts: [] } });
    } else if (path.endsWith("/part")) {
      signed++;
      return route.fulfill({
        headers,
        json: {
          url: storage + "/private-signed-fixture",
          expiresAt: Date.now() + 60000,
        },
      });
    } else if (path.endsWith("/pause")) {
      file!.status = "interrupted";
    } else if (path.endsWith("/complete")) {
      expect(writes).toBe(2);
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
  await open();
  await page.getByLabel("Blompへ保存するファイル").setInputFiles({
    name: "test.mp4",
    mimeType: "video/mp4",
    buffer: original,
  });
  await page.getByRole("button", { name: "Blompに保存", exact: true }).click();
  await expect.poll(() => file?.status).toBe("interrupted");
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
  await reselect.setInputFiles({
    name: "test.mp4",
    mimeType: "video/mp4",
    buffer: original,
  });
  await page.getByRole("button", { name: "転送を再開" }).click();
  await expect(
    page.getByRole("button", { name: "ダウンロードを準備" }),
  ).toBeVisible();
  expect(signed).toBe(2);
  expect(
    await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
  ).not.toContain("private-signed-fixture");
  expect(errors).toEqual([]);
});
