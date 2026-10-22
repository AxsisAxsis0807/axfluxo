import { test, expect, type Page } from "@playwright/test";
import { unzipSync } from "fflate";
import { readFile } from "node:fs/promises";
import type { ProjectDocument } from "../../src/domain/document";
async function readProjects(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("axfluxo", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise<ProjectDocument[]>((resolve, reject) => {
        const r = db.transaction("projects").objectStore("projects").getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  });
}
async function start(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "新しいプロジェクト", exact: true })
    .click();
}
async function closePanel(page: Page) {
  const close = page.getByLabel("設定を閉じる", { exact: true });
  if (await close.isVisible()) await close.click();
}
async function openPanel(page: Page) {
  const button = page.getByLabel("プロパティを表示");
  if (await button.isVisible()) await button.click();
}
test("multi-tab CAS conflict retains both documents via copy recovery", async ({
  page,
  context,
}) => {
  await start(page);
  await page.getByLabel("図形を追加", { exact: true }).click();
  await closePanel(page);
  await expect(page.getByRole("status")).toContainText("この端末に保存済み");
  const other = await context.newPage();
  await other.goto("/");
  await other.locator(".project-meta button").first().click();
  await page.getByLabel("テキストを追加", { exact: true }).click();
  await closePanel(page);
  await expect(page.getByRole("status")).toContainText("この端末に保存済み");
  await other.getByLabel("図形を追加", { exact: true }).click();
  await closePanel(other);
  await expect(other.getByRole("status")).toContainText("競合");
  await other.getByRole("button", { name: "コピーとして保存" }).click();
  await expect(other.getByRole("status")).toContainText("この端末に保存済み");
  const projects = await readProjects(other);
  expect(projects).toHaveLength(2);
  expect(
    projects.map((p) => p.pages[0].layers.map((l) => l.kind).join(",")),
  ).toEqual(expect.arrayContaining(["shape,text", "shape,shape"]));
  await other.close();
});
test("JPEG background flattening, hidden layers, Undo/Redo and ordered multipage ZIP", async ({
  page,
}) => {
  await start(page);
  await openPanel(page);
  await page
    .getByRole("button", { name: "透明背景にする", exact: true })
    .click();
  await closePanel(page);
  await page.getByLabel("図形を追加", { exact: true }).click();
  await closePanel(page);
  await page.getByLabel("元に戻す", { exact: true }).click();
  await page.getByLabel("やり直す", { exact: true }).click();
  await page.getByLabel("レイヤーを表示", { exact: true }).click();
  await page.getByLabel("図形の表示切替").click();
  await page.getByLabel("図形のロック切替").click();
  await page.locator(".layer-row").getByRole("button").first().click();
  await expect(page.getByLabel("レイヤー削除", { exact: true })).toBeDisabled();
  await closePanel(page);
  await page.getByRole("button", { name: "書き出し", exact: true }).click();
  await page.getByLabel("形式", { exact: true }).selectOption("jpeg");
  await page
    .getByRole("button", { name: "プレビューを生成", exact: true })
    .click();
  await expect(page.getByAltText("書き出しプレビュー")).toBeVisible();
  const pixel = await page
    .getByAltText("書き出しプレビュー")
    .evaluate((img: HTMLImageElement) => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(540, 540, 1, 1).data];
    });
  expect(pixel).toEqual([255, 255, 255, 255]);
  await page.getByLabel("書き出しを閉じる", { exact: true }).click();
  await page.getByLabel("ページ追加", { exact: true }).click();
  await page.getByRole("button", { name: "書き出し", exact: true }).click();
  await page.getByLabel("範囲", { exact: true }).selectOption("all");
  await page
    .getByRole("button", { name: "プレビューを生成", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "ファイルを保存" }),
  ).toBeVisible();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "ファイルを保存" }).click();
  const path = await (await pending).path();
  const entries = unzipSync(new Uint8Array(await readFile(path!)));
  expect(Object.keys(entries)).toEqual(["01-ページ.jpg", "02-ページ.jpg"]);
});
test("original two-page sample exports and template reuse keeps source and IDs independent", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "2ページのサンプルを試す ↗" }).click();
  await expect(page.getByLabel("プロジェクト名")).toHaveValue(
    "サンプル — 2ページの紹介画像",
  );
  await openPanel(page);
  await page.getByRole("button", { name: "変数", exact: true }).click();
  await page
    .getByLabel("紹介文の値", { exact: true })
    .fill("A new creative story");
  await page.getByLabel("紹介文の値", { exact: true }).blur();
  await closePanel(page);
  await expect(page.getByRole("status")).toContainText("この端末に保存済み");
  const original = (await readProjects(page))[0];
  await page.getByRole("button", { name: "書き出し", exact: true }).click();
  await page
    .getByRole("button", { name: "プレビューを生成", exact: true })
    .click();
  await expect(page.getByAltText("書き出しプレビュー")).toBeVisible();
  await page.getByLabel("書き出しを閉じる", { exact: true }).click();
  await openPanel(page);
  await page.getByRole("button", { name: "デザイン", exact: true }).click();
  await page
    .getByRole("button", { name: "テンプレート保存", exact: true })
    .click();
  await closePanel(page);
  await page.getByRole("button", { name: "テンプレート", exact: true }).click();
  await expect(page.locator(".template-card")).toHaveCount(1);
  await page.getByRole("button", { name: "このレイアウトで作成" }).click();
  await openPanel(page);
  await page.getByRole("button", { name: "変数", exact: true }).click();
  await page
    .getByLabel("紹介文の値", { exact: true })
    .fill("A completely different story");
  await page.getByLabel("紹介文の値", { exact: true }).blur();
  await closePanel(page);
  await expect(page.getByRole("status")).toContainText("この端末に保存済み");
  const projects = await readProjects(page);
  expect(projects).toHaveLength(2);
  const source = projects.find((p) => p.id === original.id)!,
    copy = projects.find((p) => p.id !== original.id)!;
  expect(source.values.description_en).toBe("A new creative story");
  expect(copy.values.description_en).toBe("A completely different story");
  expect(copy.pages[0].id).not.toBe(source.pages[0].id);
  expect(copy.pages[0].layers[0].id).not.toBe(source.pages[0].layers[0].id);
  expect(copy.templateOrigin).toBeDefined();
});
