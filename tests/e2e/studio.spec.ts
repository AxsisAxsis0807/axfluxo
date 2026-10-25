import { test, expect } from "@playwright/test";
async function start(page: import("@playwright/test").Page) {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "次のアイデアを、ここから。" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "新しいプロジェクト", exact: true })
    .click();
  await expect(page.getByLabel("プロジェクト名")).toBeVisible();
}
async function closeInspector(page: import("@playwright/test").Page) {
  if (await page.getByLabel("設定を閉じる", { exact: true }).isVisible())
    await page.getByLabel("設定を閉じる", { exact: true }).click();
}
test("edit, autosave, reload and immutable template reuse", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  await page.getByLabel("テキストを追加", { exact: true }).click();
  await page
    .getByLabel("文字入力", { exact: true })
    .fill("日本語の作品\nHello AxFluxo");
  await page.getByLabel("文字入力", { exact: true }).blur();
  await expect(page.getByRole("status")).toContainText("この端末に保存済み");
  await closeInspector(page);
  await expect(page.locator(".artboard canvas").first()).toBeVisible();
  await page.screenshot({
    path: `test-results/studio-${info.project.name}.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(page.locator(".project-meta button").first()).toBeVisible();
  await page.locator(".project-meta button").first().click();
  await page.getByLabel("レイヤーを表示", { exact: true }).click();
  await page.locator(".layer-row").getByRole("button").first().click();
  await expect(page.getByLabel("文字入力", { exact: true })).toHaveValue(
    "日本語の作品\nHello AxFluxo",
  );
  await closeInspector(page);
  if (info.project.name === "desktop") {
    await page
      .getByRole("button", { name: "テンプレート保存", exact: true })
      .click();
    await page
      .getByRole("button", { name: "テンプレート", exact: true })
      .click();
    await expect(page.locator(".template-card")).toHaveCount(1);
    await page.getByRole("button", { name: "このレイアウトで作成" }).click();
    await expect(page.getByLabel("プロジェクト名")).toHaveValue(
      "無題のプロジェクト の作品",
    );
  }
  expect(errors).toEqual([]);
});
test("image crop draft cancel/apply, PNG dimensions, ZIP backup restore", async ({
  page,
  browser,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  const bytes = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 600;
    c.height = 1200;
    const x = c.getContext("2d")!;
    x.fillStyle = "#e52d45";
    x.fillRect(0, 0, 300, 1200);
    x.fillStyle = "#32b4e7";
    x.fillRect(300, 0, 300, 1200);
    return [
      ...Uint8Array.from(atob(c.toDataURL().split(",")[1]), (c) =>
        c.charCodeAt(0),
      ),
    ];
  });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "own-geometric.png",
      mimeType: "image/png",
      buffer: Buffer.from(bytes),
    });
  await expect(
    page.getByRole("button", { name: "中央固定クロップ", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "中央固定クロップ", exact: true })
    .click();
  await page.getByLabel("クロップ回転").fill("30");
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page
    .getByRole("button", { name: "中央固定クロップ", exact: true })
    .click();
  await expect(page.getByLabel("クロップ回転")).toHaveValue("0");
  await page.getByLabel("クロップ回転").fill("45");
  const cropBox = await page.locator(".crop-dialog canvas").boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const center = {
    x: cropBox!.x + cropBox!.width / 2,
    y: cropBox!.y + cropBox!.height / 2,
  };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: center.x - 35, y: center.y, id: 1 },
      { x: center.x + 35, y: center.y, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: center.x - 70, y: center.y, id: 1 },
      { x: center.x + 70, y: center.y, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(async () =>
      Number(await page.getByLabel("クロップ拡大").inputValue()),
    )
    .toBeGreaterThan(1.5);
  await cdp.detach();
  await page.getByRole("button", { name: "適用", exact: true }).click();
  await closeInspector(page);
  await expect(page.getByRole("status")).toContainText("この端末に保存済み");
  await page.getByRole("button", { name: "書き出し", exact: true }).click();
  await page
    .getByRole("button", { name: "プレビューを生成", exact: true })
    .click();
  await expect(page.getByAltText("書き出しプレビュー")).toBeVisible();
  const dims = await page
    .getByAltText("書き出しプレビュー")
    .evaluate((img: HTMLImageElement) => ({
      width: img.naturalWidth,
      height: img.naturalHeight,
    }));
  expect(dims).toEqual({ width: 1080, height: 1080 });
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "ファイルを保存" }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.png$/);
  await page.getByLabel("書き出しを閉じる", { exact: true }).click();
  if (info.project.name === "desktop") {
    const pendingBackup = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "バックアップ", exact: true })
      .click();
    const downloaded = await pendingBackup;
    const path = await downloaded.path();
    expect(downloaded.suggestedFilename()).toMatch(/\.axfluxo\.zip$/);
    const empty = await browser.newContext();
    const restored = await empty.newPage();
    await restored.goto(page.url());
    await restored
      .getByRole("heading", { name: "次のアイデアを、ここから。" })
      .waitFor();
    await restored.locator("input[type=file]").nth(2).setInputFiles(path!);
    await expect(restored.getByLabel("プロジェクト名")).toBeVisible();
    await restored.getByLabel("端末に保存", { exact: true }).click();
    await expect(restored.getByRole("status")).toContainText(
      "この端末に保存済み",
    );
    await restored
      .getByRole("button", { name: "書き出し", exact: true })
      .click();
    await restored
      .getByRole("button", { name: "プレビューを生成", exact: true })
      .click();
    await expect(restored.getByAltText("書き出しプレビュー")).toBeVisible();
    await empty.close();
  }
  expect(errors).toEqual([]);
});

// Preserve the existing Studio/Phase 1 regression suite through its explicit legacy entry.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("axfluxo-view", "legacy"),
  );
});
