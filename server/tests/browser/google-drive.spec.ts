import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { createHash } from "node:crypto";
let bundle: string;
const base = "/api/integrations/google-drive";
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [
      new URL("google-drive-fixture.tsx", import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN": '"https://drive-api.test"',
      "process.env.NODE_ENV": '"test"',
      "process.env": "{}",
    },
  });
  bundle = result.outputFiles[0].text;
});
test("static diagnostic panel uploads, downloads, hashes, retries same operation and disconnects", async ({
  page,
}) => {
  const errors: string[] = [],
    operations: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let content = "",
    hash = "";
  await page.route("https://drive-api.test/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const headers = {
      "access-control-allow-origin": "https://drive-ui.test",
      "access-control-allow-headers":
        "authorization,content-type,idempotency-key",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    expect(request.headers().authorization).toBe("Bearer supabase-test-token");
    let body: unknown = {};
    if (path.endsWith("/status")) body = { connected: true, folders: null };
    else if (path.endsWith("/disconnect")) body = { connected: false };
    else if (path.endsWith("/files")) {
      const payload = request.postDataJSON();
      operations.push(payload.operationId);
      content = payload.base64;
      hash = createHash("sha256")
        .update(Buffer.from(content, "base64"))
        .digest("hex");
      body = {
        fileId: "drive-test-file",
        size: Buffer.from(content, "base64").length,
        sha256: hash,
        verified: true,
      };
    } else if (path.endsWith("/files/drive-test-file"))
      body = {
        fileId: "drive-test-file",
        size: Buffer.from(content, "base64").length,
        sha256: hash,
        base64: content,
        verified: true,
      };
    await route.fulfill({ json: body, headers });
  });
  await page.route("https://drive-ui.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="root"></div><script>' + bundle + "</script>",
    }),
  );
  await page.goto("https://drive-ui.test/developer/video/");
  await page
    .getByRole("button", { name: "接続状態を確認", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("接続済み");
  const upload = page.getByRole("button", {
    name: "テストファイルを保存・取得・検証",
  });
  await upload.click();
  await expect(page.getByRole("status")).toContainText("SHA-256の一致");
  await upload.click();
  await expect(page.getByRole("status")).toContainText("SHA-256の一致");
  expect(operations).toHaveLength(2);
  expect(operations[0]).toBe(operations[1]);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.getByRole("button", { name: "接続解除", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("保持されています");
  expect(errors).toEqual([]);
});
test("accepts preparation nonce from fragment, removes it from history and binds connect request", async ({
  page,
}) => {
  const binding = "a".repeat(43);
  let received = "";
  await page.route("https://drive-ui.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="root"></div><script>' + bundle + "</script>",
    }),
  );
  await page.route("https://drive-api.test/**", async (route) => {
    const headers = {
      "access-control-allow-origin": "https://drive-ui.test",
      "access-control-allow-headers":
        "authorization,content-type,idempotency-key",
      "access-control-allow-methods": "POST,OPTIONS",
    };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (new URL(route.request().url()).pathname === base + "/connect") {
      received = route.request().postDataJSON().binding;
      await route.fulfill({
        headers,
        json: { url: "https://drive-api.test" + base + "/start?state=dummy" },
      });
      return;
    }
    await route.fulfill({ contentType: "text/plain", body: "OAuth start" });
  });
  await page.goto(
    "https://drive-ui.test/developer/video/#drive-binding=" + binding,
  );
  await expect(page.getByRole("status")).toContainText(
    "ブラウザを確認しました",
  );
  expect(new URL(page.url()).hash).toBe("");
  await page.getByRole("button", { name: "接続・再接続", exact: true }).click();
  await expect(page).toHaveURL(/\/start\?state=dummy/);
  expect(received).toBe(binding);
});
