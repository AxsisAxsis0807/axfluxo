import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
let bundle: string;
const id = "11111111-1111-4111-8111-111111111111",
  hash = "a".repeat(64);
test.beforeAll(async () => {
  bundle = (
    await build({
      entryPoints: ["server/tests/browser/outputs-fixture.tsx"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env": "{}", "process.env.NODE_ENV": '"test"' },
    })
  ).outputFiles[0].text;
});
test("saving, cancelling share and opening a huge MP4 never confirm saved; explicit Photos confirmation is required", async ({
  page,
  context,
}) => {
  let confirmations = 0,
    mediaRequests = 0;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", { value: () => true });
    Object.defineProperty(navigator, "share", {
      value: async () => {
        throw new DOMException("cancel", "AbortError");
      },
    });
  });
  await context.route("https://outputs-api.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname,
      headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers":
          "authorization,content-type,idempotency-key",
        "access-control-allow-methods": "GET,POST,OPTIONS",
      };
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    const item = {
      id,
      versionId: "version-1",
      hash,
      size: 3,
      createdAt: new Date().toISOString(),
      filename: "日本語.mp4",
      unconfirmed30Days: true,
      state: "unconfirmed",
      reason: null,
    };
    let body: unknown = {};
    if (path === "/outputs")
      body = {
        items: [
          item,
          {
            ...item,
            id: "22222222-2222-4222-8222-222222222222",
            filename: "巨大.mp4",
            size: 10 * 1024 ** 3,
          },
        ],
        nextCursor: null,
      };
    else if (path.endsWith("/access"))
      body = {
        url: "https://media.test/private.mp4",
        expiresAt: Date.now() + 60000,
        hash,
        size: path.includes(id) ? 3 : 10 * 1024 ** 3,
      };
    else if (path.endsWith("/confirm-saved")) {
      confirmations++;
      expect(route.request().postDataJSON()).toEqual({
        versionId: "version-1",
        hash,
        photoLibraryChecked: true,
      });
      body = { outputId: id, state: "pending" };
    }
    await route.fulfill({
      headers,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await context.route("https://media.test/**", async (route) => {
    mediaRequests++;
    await route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      body: Buffer.from([1, 2, 3]),
    });
  });
  await page.route("**/__developer_test__/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("./__developer_test__/");
  await page.addScriptTag({ content: bundle });
  const small = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "日本語.mp4" }) });
  await expect(small.getByText("30日以上", { exact: false })).toBeVisible();
  const confirm = small.getByRole("button", {
    name: "保存確認・サーバーから削除",
  });
  await expect(confirm).toBeDisabled();
  await small.getByRole("button", { name: "小さいMP4を共有用に準備" }).click();
  await small.getByRole("button", { name: "共有", exact: true }).click();
  await expect(
    page.getByText("共有をキャンセルしました。保存未確認です。"),
  ).toBeVisible();
  expect(confirmations).toBe(0);
  const huge = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "巨大.mp4" }) });
  await expect(
    huge.getByRole("button", { name: "小さいMP4を共有用に準備" }),
  ).toHaveCount(0);
  await huge.getByRole("button", { name: "MP4 / Files用リンクを取得" }).click();
  await expect(
    huge.getByRole("link", { name: "MP4を開く・Filesへ保存" }),
  ).toBeVisible();
  expect(mediaRequests).toBe(1);
  expect(confirmations).toBe(0);
  await small.getByRole("checkbox").check();
  await confirm.click();
  await expect.poll(() => confirmations).toBe(1);
});
test("auth refresh failure is safely displayed", async ({ page }) => {
  await page.route("https://outputs-api.test/**", (route) =>
    route.fulfill({
      status: route.request().method() === "OPTIONS" ? 204 : 401,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization",
      },
      body:
        route.request().method() === "OPTIONS"
          ? ""
          : JSON.stringify({ error: { code: "AUTH_EXPIRED" } }),
    }),
  );
  await page.route("**/__developer_test__/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("./__developer_test__/");
  await page.addScriptTag({ content: bundle });
  await expect(
    page.getByText("ログインの期限が切れました。", { exact: false }),
  ).toBeVisible();
});
test("manifest and service worker remain within developer scope and never install a media cache", async ({
  page,
  baseURL,
}) => {
  const base = new URL(baseURL!).pathname.replace(/\/$/, "");
  const response = await page.request.get(`${base}/developer.webmanifest`),
    manifest = await response.json();
  expect(manifest.scope).toBe(`${base}/developer/`);
  expect(manifest.start_url).toBe(`${base}/developer/studio/`);
  const sw = await (await page.request.get(`${base}/developer-sw.js`)).text();
  expect(sw).not.toMatch(/addEventListener\(['"]fetch/);
  expect(sw).not.toContain("caches.open");
  expect(sw).not.toContain("clients.claim");
  await page.goto("./developer/studio/");
  await expect(
    page.getByRole("heading", { name: "Developer Studio 簡易ロック" }),
  ).toBeVisible();
  expect(
    await page.evaluate(async () =>
      navigator.serviceWorker.getRegistrations().then((rs) => rs.length),
    ),
  ).toBe(0);
});
test("worker script validates notification targets and activates an update only on explicit message", async () => {
  const vm = await import("node:vm");
  const handlers: Record<string, (event: unknown) => void> = {};
  let activated = 0,
    shown = 0,
    opened = "";
  const scope = "https://app.test/axfluxo/developer/";
  vm.runInNewContext(await readFile("public/developer-sw.js", "utf8"), {
    URL,
    self: {
      addEventListener: (name: string, fn: (event: unknown) => void) => {
        handlers[name] = fn;
      },
      skipWaiting: () => {
        activated++;
      },
      registration: {
        scope,
        showNotification: async () => {
          shown++;
        },
      },
    },
    clients: {
      matchAll: async () => [],
      openWindow: async (url: string) => {
        opened = url;
      },
    },
  });
  handlers.message({ data: "unrelated" });
  expect(activated).toBe(0);
  handlers.message({ data: "ACTIVATE_UPDATE" });
  expect(activated).toBe(1);
  const work: Promise<unknown>[] = [];
  handlers.push({
    data: {
      json: () => ({
        batchId: id,
        kind: "completed",
        url: "https://evil.test/",
      }),
    },
    waitUntil: (p: Promise<unknown>) => work.push(p),
  });
  await Promise.all(work);
  expect(shown).toBe(1);
  handlers.notificationclick({
    notification: { close() {} },
    waitUntil: (p: Promise<unknown>) => work.push(p),
  });
  await Promise.all(work);
  expect(opened).toBe(`${scope}studio/`);
});

test("push permission denial occurs only after a tap and preserves the output list", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let requests = 0;
    class MockNotification {
      static permission = "default";
      static async requestPermission() {
        requests++;
        (
          window as unknown as { permissionRequests: number }
        ).permissionRequests = requests;
        return "denied";
      }
    }
    Object.defineProperty(window, "Notification", { value: MockNotification });
    Object.defineProperty(window, "PushManager", { value: class {} });
    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        register: async () => ({
          addEventListener() {},
          waiting: null,
          pushManager: { getSubscription: async () => null },
        }),
      },
    });
  });
  await page.route("https://outputs-api.test/**", (route) =>
    route.fulfill({
      status: route.request().method() === "OPTIONS" ? 204 : 200,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization",
      },
      body:
        route.request().method() === "OPTIONS"
          ? ""
          : JSON.stringify(
              new URL(route.request().url()).pathname === "/push/config"
                ? { enabled: true, publicKey: "BAAAAA" }
                : { items: [], nextCursor: null },
            ),
    }),
  );
  await page.route("**/__developer_test__/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("./__developer_test__/");
  await page.addScriptTag({ content: bundle });
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { permissionRequests?: number })
          .permissionRequests ?? 0,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "開発者PWAを準備" }).click();
  await page.getByRole("button", { name: "通知を許可・登録" }).click();
  await expect(
    page.getByText("通知は許可されていません。完成動画は一覧に保持されます。"),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { permissionRequests: number })
          .permissionRequests,
    ),
  ).toBe(1);
});
