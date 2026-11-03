import { test, expect, type BrowserContext } from "@playwright/test";
import { unavailableDeveloperServices } from "../../server/contracts/developer-services";
const enabled = process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED === "true",
  apiOrigin = process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
test.beforeEach(async ({ context }) => {
  await context.route("https://*.supabase.co/auth/v1/**", (r) =>
    r.fulfill({
      status: 400,
      json: {
        code: "refresh_token_not_found",
        message: "Test refresh failure",
      },
    }),
  );
});
const owner = "11111111-1111-4111-8111-111111111111";
async function session(context: BrowserContext) {
  await context.addInitScript(
    ({ owner }) => {
      localStorage.setItem(
        "axfluxo-auth",
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          expires_in: 3600,
          token_type: "bearer",
          user: {
            id: owner,
            aud: "authenticated",
            role: "authenticated",
            email: "test@example.com",
            app_metadata: { provider: "email" },
            user_metadata: { developer: true },
            created_at: new Date().toISOString(),
          },
        }),
      );
      localStorage.setItem("developer", "true");
    },
    { owner },
  );
}
async function backend(
  context: BrowserContext,
  role: { value: "developer" | "general" | "expired" | "offline" },
) {
  const calls: string[] = [];
  if (!apiOrigin) return calls;
  await context.route(`${apiOrigin.replace(/\/$/, "")}/**`, async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    calls.push(path);
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization,content-type,idempotency-key,x-project-owner",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    if (req.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    if (role.value === "offline") return route.abort();
    if (role.value !== "developer")
      return route.fulfill({
        status: role.value === "general" ? 403 : 401,
        headers,
        json: {
          error: {
            code:
              role.value === "general" ? "DEVELOPER_REQUIRED" : "AUTH_EXPIRED",
          },
        },
      });
    if (path === "/v1/developer/me")
      return route.fulfill({
        headers,
        json: { ownerId: owner, membership: "developer" },
      });
    if (path === "/v1/developer/services")
      return route.fulfill({ headers, json: unavailableDeveloperServices });
    if (path === "/fnf-showcase/batches")
      return route.fulfill({ headers, json: { items: [], nextCursor: null } });
    return route.fulfill({
      status: 503,
      headers,
      json: { error: { code: "ADMISSION_CLOSED" } },
    });
  });
  return calls;
}
test("direct URLs never mount editing controls before server authorization; OFF performs no protected work", async ({
  page,
  context,
}) => {
  const role = { value: "general" as const },
    calls = await backend(context, role);
  for (const route of [
    "studio",
    "all-versions",
    "fnf-showcase",
    "library",
    "preview",
    "video",
  ]) {
    await page.goto(`./developer/${route}/`);
    if (enabled)
      await expect(
        page.getByText(
          "ログインしてください。開発者権限はサーバーで確認します。",
        ),
      ).toBeVisible();
    await expect(page.getByLabel("@username", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "全長を書き出す" }),
    ).toHaveCount(0);
  }
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
});
test("a general user cannot promote through metadata, localStorage or direct URLs", async ({
  page,
  context,
}) => {
  await session(context);
  const role = { value: "general" as const },
    calls = await backend(context, role);
  await page.goto("./");
  await expect(
    page.getByRole("link", { name: "Developer Studioを別タブで開く" }),
  ).toHaveCount(0);
  for (const route of [
    "studio",
    "all-versions",
    "fnf-showcase",
    "library",
    "preview",
    "video",
  ]) {
    await page.goto(`./developer/${route}/?owner=${owner}`);
    if (enabled)
      await expect(
        page.getByText(
          "開発者権限がありません。一般アカウントでは利用できません。",
        ),
      ).toBeVisible();
    await expect(page.getByLabel("@username", { exact: true })).toHaveCount(0);
  }
  expect(calls.filter((p) => p !== "/v1/developer/me")).toEqual([]);
});
test("developer entry keeps the current Workflow editor mounted; tools open in separate tabs and survive reload", async ({
  page,
  context,
}) => {
  await session(context);
  const role: { value: "developer" | "general" | "expired" | "offline" } = {
    value: "developer",
  };
  const calls = await backend(context, role);
  await page.goto("./");
  const entry = page.getByRole("link", {
    name: "Developer Studioを別タブで開く",
  });
  if (!enabled) {
    await expect(entry).toHaveCount(0);
    expect(calls).toEqual([]);
    return;
  }
  await expect(entry).toBeVisible();
  expect((await entry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("button", { name: "＋ 画像編集", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "画像編集ノード詳細" });
  await panel.getByLabel("入力方法", { exact: true }).selectOption("blank");
  await panel
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  await page.getByLabel("テキストを追加", { exact: true }).click();
  const field = page.getByLabel("文字入力", { exact: true });
  await field.fill("元の未適用編集を保持");
  const handle = await field.elementHandle();
  const opening = context.waitForEvent("page");
  await entry.click();
  const studio = await opening;
  await studio.waitForLoadState();
  await expect(
    studio.getByText(
      "開発者権限をサーバーで確認しました。利用できる編集ツールを選択してください。",
    ),
  ).toBeVisible();
  expect(await handle!.evaluate((el) => el.isConnected)).toBe(true);
  await expect(field).toHaveValue("元の未適用編集を保持");
  for (const [name, flag] of [
    ["All Versions Video Maker", process.env.NEXT_PUBLIC_ALL_VERSIONS_ENABLED],
    ["FNF Showcase Maker", process.env.NEXT_PUBLIC_FNF_SHOWCASE_ENABLED],
  ]) {
    const link = studio.getByRole("link", { name: `${name}を別タブで開く` });
    if (flag !== "true") {
      await expect(link).toHaveCount(0);
      continue;
    }
    const openingTool = context.waitForEvent("page");
    await link.click();
    const tool = await openingTool;
    await expect(
      tool.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    if (name === "FNF Showcase Maker") {
      const username = tool.getByLabel("@username", { exact: true });
      await username.fill("@日本語");
      const usernameNode = await username.elementHandle();
      await tool.evaluate(async () => {
        const ch = new BroadcastChannel("axfluxo-auth");
        ch.postMessage({
          event: "SIGNED_IN",
          session: JSON.parse(localStorage.getItem("axfluxo-auth")!),
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        ch.close();
      });
      await expect(username).toHaveValue("@日本語");
      expect(await usernameNode!.evaluate((el) => el.isConnected)).toBe(true);
      role.value = "offline";
      await tool.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(
        tool.getByText(
          "開発者権限を確認できません。接続を確認し、再試行してください。",
        ),
      ).toBeVisible();
      expect(await usernameNode!.evaluate((el) => el.isConnected)).toBe(true);
      role.value = "developer";
      await tool.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await expect(username).toBeVisible();
      await expect(username).toHaveValue("@日本語");

      await tool
        .getByRole("button", { name: "template・usernameを保存" })
        .click();
      await expect(
        tool.getByText("端末に設定保存済み・cloud未保存"),
      ).toBeVisible();
    }
    if (name === "All Versions Video Maker") {
      await tool.getByRole("button", { name: /6\..*書き出し/ }).click();
      await expect(
        tool.getByRole("button", { name: "全長を書き出す" }),
      ).toBeDisabled();
    }
    expect(
      await tool.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await tool.reload();
    await expect(
      tool.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await tool.close();
  }
  await studio.reload();
  await expect(
    studio.getByText(
      "開発者権限をサーバーで確認しました。利用できる編集ツールを選択してください。",
    ),
  ).toBeVisible();
  role.value = "general";
  await studio.getByRole("button", { name: "開発者権限を再確認" }).count();
  await studio.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(
    studio.getByText(
      "開発者権限がありません。一般アカウントでは利用できません。",
    ),
  ).toBeVisible();
  await expect(
    studio.getByRole("link", {
      name: "All Versions Video Makerを別タブで開く",
    }),
  ).toHaveCount(0);
  expect(
    calls.filter((p) => /^\/(cloud|render-|projects|preferences)/.test(p)),
  ).toEqual([]);
});
test("unreachable authorization never grants access from a cached browser session", async ({
  page,
  context,
}) => {
  await session(context);
  const role = { value: "offline" as const };
  await backend(context, role);
  await page.goto("./developer/fnf-showcase/");
  if (enabled)
    await expect(
      page.getByText(
        "開発者権限を確認できません。接続を確認し、再試行してください。",
      ),
    ).toBeVisible();
  await expect(page.getByLabel("@username", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
});

test("token refresh failure stays closed and reauthorization recovers after background return", async ({
  page,
  context,
}) => {
  await session(context);
  const role: { value: "developer" | "general" | "expired" | "offline" } = {
    value: "expired",
  };
  await backend(context, role);
  await page.goto("./developer/studio/");
  if (!enabled) {
    await expect(
      page.getByText("開発者Studioの入口は停止中です。"),
    ).toBeVisible();
    return;
  }
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /認証期限|ログインしてください/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "All Versions Video Makerを別タブで開く" }),
  ).toHaveCount(0);
  await page.evaluate(
    ({ owner }) =>
      localStorage.setItem(
        "axfluxo-auth",
        JSON.stringify({
          access_token: "new-test-access-token",
          refresh_token: "new-test-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: "bearer",
          user: {
            id: owner,
            aud: "authenticated",
            role: "authenticated",
            email: "test@example.com",
            app_metadata: { provider: "email" },
            user_metadata: {},
            created_at: new Date().toISOString(),
          },
        }),
      ),
    { owner },
  );
  role.value = "developer";
  await page.reload();
  await expect(
    page.getByText(
      "開発者権限をサーバーで確認しました。利用できる編集ツールを選択してください。",
    ),
  ).toBeVisible();
  role.value = "offline";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(
    page.getByText(
      "開発者権限を確認できません。接続を確認し、再試行してください。",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "All Versions Video Makerを別タブで開く" }),
  ).toHaveCount(0);
  role.value = "developer";
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByText(
      "開発者権限をサーバーで確認しました。利用できる編集ツールを選択してください。",
    ),
  ).toBeVisible();
});
