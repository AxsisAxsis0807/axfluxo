// Local static review only. Start independently built enabled/disabled artifacts first.
import { chromium, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const result = {};
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(process.env.WORKFLOW_REVIEW_URL || "http://127.0.0.1:3100/");
  await page.getByRole("button", { name: "＋ 画像編集", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "画像編集ノード詳細" });
  await panel.getByLabel("入力方法", { exact: true }).selectOption("blank");
  await panel
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  await page.getByLabel("ページ追加", { exact: true }).click();
  await page.getByLabel("ページ名", { exact: true }).fill("出力2");
  await page.getByLabel("キャンバス幅", { exact: true }).fill("128");
  await page.getByLabel("キャンバス高さ", { exact: true }).fill("96");
  await page.getByLabel("キャンバス高さ", { exact: true }).blur();
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(
    panel
      .getByLabel("出力対象ページ", { exact: true })
      .locator("option:checked"),
  ).toHaveText("出力2");
  await panel
    .getByRole("button", { name: "出力画像を更新", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "出力画像をダウンロード", exact: true }),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await panel
    .getByRole("button", { name: "出力画像をダウンロード", exact: true })
    .click();
  const bytes = await readFile(await (await downloaded).path());
  expect(bytes.readUInt32BE(16)).toBe(128);
  expect(bytes.readUInt32BE(20)).toBe(96);
  await panel
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  await expect(page.getByLabel("キャンバス幅", { exact: true })).toHaveValue(
    "128",
  );
  await expect(page.getByLabel("キャンバス高さ", { exact: true })).toHaveValue(
    "96",
  );
  result.selectedPage = { width: 128, height: 96, reopenedSelectedPage: true };
  await page.close();
  if (process.env.WORKFLOW_ROLLBACK_URL) {
    const rollback = await browser.newPage();
    await rollback.goto(process.env.WORKFLOW_ROLLBACK_URL);
    await expect(
      rollback.getByRole("heading", { name: "次のアイデアを、ここから。" }),
    ).toBeVisible();
    await expect(
      rollback.getByRole("button", { name: "旧Studioを開く", exact: true }),
    ).toHaveCount(0);
    const preserved = await rollback.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const id = crypto.randomUUID(),
            row = {
              id,
              document: {
                schemaVersion: 2,
                workflowId: id,
                name: "preserve-v2",
                revision: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                nodes: [],
                edges: [],
              },
            },
            r = indexedDB.open("axfluxo-workspace", 1);
          r.onupgradeneeded = () => {
            for (const name of [
              "workflows",
              "preferences",
              "editorDocuments",
              "editorRevisions",
              "assets",
              "artifacts",
              "recovery",
              "migrations",
            ])
              r.result.createObjectStore(name, { keyPath: "id" });
          };
          r.onerror = () => reject(r.error);
          r.onsuccess = () => {
            const db = r.result,
              tx = db.transaction("workflows", "readwrite");
            tx.objectStore("workflows").add(row);
            tx.oncomplete = () => {
              db.close();
              resolve(row);
            };
          };
        }),
    );
    await rollback
      .getByRole("button", { name: "新しいプロジェクト", exact: true })
      .click();
    await rollback.getByLabel("図形を追加", { exact: true }).click();
    await expect(rollback.getByRole("status")).toContainText(
      "この端末に保存済み",
    );
    await rollback.reload();
    await expect(
      rollback.locator(".project-meta button").first(),
    ).toBeVisible();
    const rows = await rollback.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const r = indexedDB.open("axfluxo-workspace", 1);
          r.onerror = () => reject(r.error);
          r.onsuccess = () => {
            const db = r.result,
              q = db.transaction("workflows").objectStore("workflows").getAll();
            q.onsuccess = () => {
              db.close();
              resolve(q.result);
            };
          };
        }),
    );
    expect(rows).toContainEqual(preserved);
    result.rollback = { legacySaveReload: true, workspaceV2Preserved: true };
    await rollback.close();
  }
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  await browser.close();
}
