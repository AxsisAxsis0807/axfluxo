import { expect, test } from "@playwright/test";
test("an asynchronous image import cannot be discarded by applying early", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("button", { name: "＋ 画像編集", exact: true }).click();
  const inspector = page.getByRole("complementary", {
    name: "画像編集ノード詳細",
  });
  await inspector.getByLabel("入力方法", { exact: true }).selectOption("blank");
  await inspector
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  const session = page.getByLabel("画像編集セッション", { exact: true });
  await expect(session).toBeVisible();
  const bytes = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    c.getContext("2d")!.fillRect(0, 0, 64, 64);
    return [
      ...Uint8Array.from(atob(c.toDataURL().split(",")[1]), (v) =>
        v.charCodeAt(0),
      ),
    ];
  });
  await page.evaluate(() => {
    const original = HTMLImageElement.prototype.decode;
    let held = false;
    HTMLImageElement.prototype.decode = function () {
      const decoded = original.call(this);
      if (held) return decoded;
      held = true;
      return decoded.then(
        () =>
          new Promise<void>((resolve) => {
            Object.defineProperty(window, "releaseImageImport", {
              value: () => {
                HTMLImageElement.prototype.decode = original;
                resolve();
              },
              configurable: true,
            });
          }),
      );
    };
  });
  await session
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "async.png",
      mimeType: "image/png",
      buffer: Buffer.from(bytes),
    });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (window as unknown as { releaseImageImport?: () => void })
            .releaseImageImport,
      ),
    )
    .toBe("function");
  await page.goBack();
  await expect(session).toBeVisible();
  await expect(session.locator(".session-bar").getByRole("status")).toHaveText(
    "画像取り込み中",
  );
  const unload = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const warning = await unload;
  expect(warning.type()).toBe("beforeunload");
  await warning.dismiss();
  expect(page.isClosed()).toBe(false);
  await expect(session).toBeVisible();
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(session).toBeVisible();
  await expect(session.getByRole("alert")).toContainText("取り込み完了");
  await page.evaluate(() => {
    (
      window as unknown as { releaseImageImport: () => void }
    ).releaseImageImport();
  });
  await expect(
    page.getByRole("button", { name: "中央固定クロップ", exact: true }),
  ).toBeVisible();
  const close = page.getByLabel("設定を閉じる", { exact: true });
  if (await close.isVisible()) await close.click();
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(inspector).toBeVisible();
  await inspector
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  await page.getByLabel("レイヤーを表示", { exact: true }).click();
  await expect(page.locator(".layer-row")).toHaveCount(1);
});
