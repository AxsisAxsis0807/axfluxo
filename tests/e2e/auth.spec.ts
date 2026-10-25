import { test, expect, type Page } from "@playwright/test";
const api = "https://nbyigfqkweodzlhwdryz.supabase.co/auth/v1";
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  aud: "authenticated",
  role: "authenticated",
  email: "test@example.com",
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: new Date().toISOString(),
};
const session = {
  access_token: "test-access-token",
  token_type: "bearer",
  refresh_token: "test-refresh-token",
  expires_in: 3600,
  user,
};
async function account(page: Page) {
  await page.goto("./");
  await page
    .getByRole("button", { name: "ログイン / 登録", exact: true })
    .click();
  return page.getByRole("dialog");
}
test("guest editor persists through registration, confirmation errors, login and logout", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route(`${api}/**`, async (route) => {
    const request = route.request();
    requests.push(request.url());
    if (request.url().includes("/signup")) {
      expect(request.headers().apikey).toMatch(/^sb_publishable_/);
      expect(new URL(request.url()).searchParams.get("redirect_to")).toBe(
        new URL("./", page.url()).href,
      );
      return route.fulfill({ json: { user, session: null } });
    }
    if (request.url().includes("/token")) {
      const body = request.postDataJSON();
      return route.fulfill(
        body.password === "wrong-password"
          ? {
              status: 400,
              json: {
                error_code: "email_not_confirmed",
                msg: "Email not confirmed",
              },
            }
          : { json: session },
      );
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("./");
  await page
    .getByRole("button", { name: "新しいプロジェクト", exact: true })
    .click();
  await page.getByLabel("プロジェクト名").fill("認証前のゲスト作品");
  await page.getByLabel("プロジェクト名").blur();
  await expect(page.getByRole("status")).toContainText("この端末に保存済み");
  await page
    .getByRole("button", { name: "ログイン / 登録", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "アカウント登録", exact: true })
    .click();
  await dialog.getByLabel("メールアドレス", { exact: true }).fill(user.email);
  await dialog
    .getByLabel("パスワード", { exact: true })
    .fill("correct-password");
  await dialog
    .getByRole("button", { name: "アカウント登録", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("メールを送信");
  await dialog.getByRole("button", { name: "ログイン", exact: true }).click();
  await dialog.getByLabel("パスワード", { exact: true }).fill("wrong-password");
  await dialog.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("確認メール");
  await dialog
    .getByLabel("パスワード", { exact: true })
    .fill("correct-password");
  await dialog.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(dialog.getByText(user.email, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "編集に戻る", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "アカウント", exact: true }).click();
  await dialog.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "制作データはこの端末に残っています",
  );
  await dialog
    .getByRole("button", { name: "ゲストとして続ける", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "ログイン / 登録", exact: true }),
  ).toBeVisible();
  // Inspect the original store without changing its schema or contents.
  const names = await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    return databases.map((db) => db.name);
  });
  expect(names.length).toBeGreaterThan(0);
  await expect(
    page.getByText("認証前のゲスト作品", { exact: true }).first(),
  ).toBeVisible();
  expect(requests.some((url) => url.includes("/signup"))).toBe(true);
});
test("reset and resend use the deployed root and show rate limiting", async ({
  page,
}) => {
  await page.route(`${api}/**`, async (route) => {
    expect(new URL(route.request().url()).searchParams.get("redirect_to")).toBe(
      new URL("./", page.url()).href,
    );
    return route.fulfill(
      route.request().url().includes("/resend")
        ? {
            status: 429,
            json: {
              error_code: "over_email_send_rate_limit",
              msg: "Rate limited",
            },
          }
        : { json: {} },
    );
  });
  const dialog = await account(page);
  await dialog
    .getByRole("button", { name: "パスワード再設定メール", exact: true })
    .click();
  await dialog.getByLabel("メールアドレス", { exact: true }).fill(user.email);
  await dialog
    .getByRole("button", { name: "パスワード再設定メール", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("メールを送信");
  await dialog
    .getByRole("button", { name: "確認メール再送", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "確認メール再送", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("上限");
});
test("recovery callback opens password form and removes URL credentials", async ({
  page,
}) => {
  await page.route(`${api}/**`, async (route) => {
    if (route.request().method() === "PUT")
      expect(route.request().postDataJSON().password).toBe("new-password-123");
    return route.fulfill({ json: user });
  });
  await page.goto(
    `./#access_token=test-access-token&refresh_token=test-refresh-token&expires_in=3600&token_type=bearer&type=recovery`,
  );
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText(
    "新しいパスワードを保存",
  );
  await dialog
    .getByLabel("パスワード", { exact: true })
    .fill("new-password-123");
  await dialog
    .getByRole("button", { name: "新しいパスワードを保存", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("更新しました");
  expect(new URL(page.url()).hash).toBe("");
});
test("expired confirmation links allow returning to guest editing", async ({
  page,
}) => {
  await page.goto(
    "./#error=access_denied&error_code=otp_expired&error_description=Expired",
  );
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toContainText("期限切れ");
  await dialog
    .getByRole("button", { name: "ゲストとして続ける", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "次のアイデアを、ここから。" }),
  ).toBeVisible();
});

test("email confirmation callback restores a signed-in account", async ({
  page,
}) => {
  await page.route(`${api}/user`, (route) => route.fulfill({ json: user }));
  await page.goto(
    "./#access_token=test-access-token&refresh_token=test-refresh-token&expires_in=3600&token_type=bearer&type=signup",
  );
  await page.getByRole("button", { name: "アカウント", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText(user.email, { exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
});

// Preserve the existing Studio/Phase 1 regression suite through its explicit legacy entry.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() =>
    sessionStorage.setItem("axfluxo-view", "legacy"),
  );
});
