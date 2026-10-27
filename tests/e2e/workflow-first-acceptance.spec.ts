import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import type { EditorRecord } from "../../src/domain/workspace/schema";
import type { WorkspaceAsset } from "../../src/services/workspace/repository";

async function add(page: Page, name: string) {
  await page.getByRole("button", { name: "＋ 画像編集", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "画像編集ノード詳細" });
  await panel.getByLabel("ノード名", { exact: true }).fill(name);
  await panel.getByLabel("入力方法", { exact: true }).selectOption("blank");
  await open(page);
}
async function open(page: Page) {
  await page
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
}
async function apply(page: Page) {
  const close = page.getByLabel("設定を閉じる", { exact: true });
  if (await close.isVisible()) await close.click();
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "画像編集ノード詳細" }),
  ).toBeVisible();
}
async function image(page: Page, mime: "image/jpeg" | "image/png") {
  return Buffer.from(
    await page.evaluate((type) => {
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 48;
      c.getContext("2d")!.fillRect(0, 0, 64, 48);
      const bytes = Array.from(atob(c.toDataURL(type).split(",")[1]), (x) =>
        x.charCodeAt(0),
      );
      c.width = c.height = 0;
      return bytes;
    }, mime),
  );
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("axfluxo-workspace", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const read = <T>(store: string) =>
        new Promise<T[]>((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const editors = await read<EditorRecord>("editorDocuments");
      const assets = await read<WorkspaceAsset>("assets");
      return {
        editors: editors.map((e) => ({
          id: e.id,
          document: e.document,
          assets: e.assets,
        })),
        assets: await Promise.all(
          assets.map(async (a) => ({
            id: a.id,
            originalMime: a.originalMime,
            blobMime: a.blob.type,
            hash: a.hash,
            originalHash: Array.from(
              new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  await a.original!.arrayBuffer(),
                ),
              ),
              (b) => b.toString(16).padStart(2, "0"),
            ).join(""),
          })),
        ),
      };
    } finally {
      db.close();
    }
  });
}

test("mixed images, text and shapes survive apply, independent nodes and reload without changing JPEG originals", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const live = new Set<string>();
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      live.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      live.delete(url);
      revoke(url);
    };
    Object.defineProperty(window, "acceptanceLiveUrls", { value: live });
  });
  await page.goto("./");
  await add(page, "受入A");
  const jpeg = await image(page, "image/jpeg"),
    png = await image(page, "image/png");
  let imported = 0;
  for (const [name, mimeType, buffer] of [
    ["original.jpg", "image/jpeg", jpeg],
    ["second.png", "image/png", png],
  ] as const) {
    await page
      .locator(".image-edit-session input[type=file]")
      .first()
      .setInputFiles({ name, mimeType, buffer });
    await expect(
      page.getByRole("button", { name: "中央固定クロップ", exact: true }),
    ).toBeVisible();
    imported++;
    await expect
      .poll(
        async () =>
          (await snapshot(page)).editors[0].document.pages[0].layers.length,
      )
      .toBe(imported);
    const close = page.getByLabel("設定を閉じる", { exact: true });
    if (await close.isVisible()) await close.click();
  }
  await page.getByLabel("テキストを追加", { exact: true }).click();
  await page.getByLabel("文字入力", { exact: true }).fill("受入Aの文字");
  await page.getByLabel("文字入力", { exact: true }).blur();
  const close = page.getByLabel("設定を閉じる", { exact: true });
  if (await close.isVisible()) await close.click();
  await page.getByLabel("図形を追加", { exact: true }).click();
  await apply(page);
  const before = await snapshot(page);
  expect(before.editors[0].document.pages[0].layers.map((l) => l.kind)).toEqual(
    ["image", "image", "text", "shape"],
  );
  expect(before.assets).toHaveLength(2);
  expect(
    before.assets.find((a) => a.originalMime === "image/jpeg")?.originalHash,
  ).toBe(createHash("sha256").update(jpeg).digest("hex"));
  expect(before.assets.every((a) => a.blobMime === "image/png")).toBe(true);
  await page.getByLabel("ノード設定を閉じる", { exact: true }).click();
  await add(page, "受入B");
  await page.getByLabel("図形を追加", { exact: true }).click();
  await apply(page);
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  const after = await snapshot(page);
  expect(after.editors.find((e) => e.id === before.editors[0].id)).toEqual(
    before.editors[0],
  );
  expect(after.assets).toEqual(before.assets);
  expect(
    after.editors
      .find((e) => e.id !== before.editors[0].id)
      ?.document.pages[0].layers.map((l) => l.kind),
  ).toEqual(["shape"]);
  const detailClose = page.getByLabel("ノード設定を閉じる", { exact: true });
  if (await detailClose.isVisible()) await detailClose.click();
  const list = page.locator(".wf-node-list");
  if (!(await list.getAttribute("open"))) await list.locator("summary").click();
  await page.getByRole("button", { name: "受入A の詳細", exact: true }).click();
  await open(page);
  await page.getByLabel("レイヤーを表示", { exact: true }).click();
  await expect(page.locator(".layer-row")).toHaveCount(4);
  await expect(page.locator(".konvajs-content canvas").first()).toBeVisible();
  const portrait = page.viewportSize()!;
  await page.setViewportSize({
    width: portrait.height,
    height: portrait.width,
  });
  expect((await snapshot(page)).editors).toEqual(after.editors);
  await page.setViewportSize(portrait);
  for (let i = 0; i < 3; i++) {
    await apply(page);
    await expect(page.locator(".konvajs-content")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { acceptanceLiveUrls: Set<string> })
              .acceptanceLiveUrls.size,
        ),
      )
      .toBe(0);
    if (i < 2) {
      await open(page);
      await expect(
        page.locator(".konvajs-content canvas").first(),
      ).toBeVisible();
    }
  }
});

test("invalid, oversized and undecodable imports preserve the document and allow a valid retry", async ({
  page,
}) => {
  await page.goto("./");
  await add(page, "失敗復旧");
  const original = await snapshot(page),
    png = await image(page, "image/png");
  const input = page.locator(".image-edit-session input[type=file]").first();
  await input.setInputFiles({
    name: "bad.png",
    mimeType: "image/png",
    buffer: Buffer.from("invalid"),
  });
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }).getByRole("alert"),
  ).toContainText("のみ対応");
  const huge = Buffer.from(png);
  huge.writeUInt32BE(20000, 16);
  await input.setInputFiles({
    name: "huge.png",
    mimeType: "image/png",
    buffer: huge,
  });
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }).getByRole("alert"),
  ).toContainText("8192px");
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      HTMLImageElement.prototype.decode = decode;
      return Promise.reject(new Error("acceptance decode failure"));
    };
  });
  await input.setInputFiles({
    name: "decode.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }).getByRole("alert"),
  ).toContainText("acceptance decode failure");
  expect(await snapshot(page)).toEqual(original);
  await input.setInputFiles({
    name: "valid.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(
    page.getByRole("button", { name: "中央固定クロップ", exact: true }),
  ).toBeVisible();
  await apply(page);
  await page.reload();
  const recovered = await snapshot(page);
  expect(recovered.editors[0].document.pages[0].layers).toHaveLength(1);
  expect(recovered.assets).toHaveLength(1);
});
