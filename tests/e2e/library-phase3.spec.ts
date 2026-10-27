import { expect, test, type Page } from "@playwright/test";
import { newExecutionNode } from "../../src/domain/workflow/execution-schema";
import { newNode } from "../../src/domain/workflow/schema";
import type { LibraryVersion } from "../../src/domain/library";
import type { Run } from "../../src/domain/workflow/execution";
async function imageFiles(page: Page) {
  return await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 64;
    const c = canvas.getContext("2d")!;
    c.fillStyle = "#d02030";
    c.fillRect(0, 0, 128, 64);
    return {
      png: canvas.toDataURL("image/png").split(",")[1],
      jpeg: canvas.toDataURL("image/jpeg").split(",")[1],
    };
  });
}
async function openLibrary(page: Page) {
  await page
    .getByRole("button", {
      name: "画像を取り込む・素材ライブラリー",
      exact: true,
    })
    .click();
  return page.getByRole("dialog", { name: "素材ライブラリー", exact: true });
}
async function rows<T>(
  page: Page,
  store: string,
  execution = false,
): Promise<T[]> {
  return page.evaluate(
    async ({ store, execution }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(
          execution ? "axfluxo-execution" : "axfluxo-workspace",
          execution ? 1 : 2,
        );
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      try {
        return await new Promise<T[]>((resolve, reject) => {
          const tx = db.transaction(store),
            r = tx.objectStore(store).getAll();
          tx.oncomplete = () => resolve(r.result);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    { store, execution },
  );
}
test("T12/T13: real PNG/JPEG multiple import, folders, rename/search/sort/trash/restore and invalid images", async ({
  page,
}) => {
  await page.goto("./");
  const data = await imageFiles(page);
  const panel = await openLibrary(page);
  const input = panel.getByLabel("ライブラリーに画像を取り込む", {
    exact: true,
  });
  await input.setInputFiles([
    {
      name: "red.png",
      mimeType: "image/png",
      buffer: Buffer.from(data.png, "base64"),
    },
    {
      name: "red.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from(data.jpeg, "base64"),
    },
  ]);
  await expect(panel.getByRole("status")).toContainText("2/2");
  await expect(panel.getByAltText("red.png サムネイル")).toBeVisible();
  await expect(panel.getByAltText("red.jpg サムネイル")).toBeVisible();
  expect(await rows(page, "libraryFiles")).toHaveLength(2);
  await input.setInputFiles({
    name: "same.png",
    mimeType: "image/png",
    buffer: Buffer.from(data.png, "base64"),
  });
  await expect(panel.getByRole("status")).toContainText("1/1");
  expect(await rows(page, "libraryFiles")).toHaveLength(2);
  await panel.getByLabel("フォルダ名", { exact: true }).fill("作品");
  await panel
    .getByRole("button", { name: "フォルダ作成", exact: true })
    .click();
  await expect(panel.getByLabel("表示フォルダ")).toContainText("作品");
  await panel.getByRole("button", { name: "red.png", exact: true }).click();
  await panel.getByLabel("素材名", { exact: true }).fill("完成素材");
  await panel
    .getByRole("button", { name: "素材名を変更", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "完成素材", exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "完成素材", exact: true }).click();
  const folder = (await rows<{ id: string }>(page, "libraryFolders"))[0].id;
  await panel.getByLabel("素材の移動先").selectOption(folder);
  await expect(
    panel.getByRole("button", { name: "完成素材", exact: true }),
  ).toHaveCount(0);
  await panel.getByLabel("表示フォルダ").selectOption(folder);
  await panel.getByLabel("素材検索", { exact: true }).fill("完成");
  await panel.getByLabel("並び順", { exact: true }).selectOption("name");
  await panel.getByRole("button", { name: "完成素材", exact: true }).click();
  await panel.getByRole("button", { name: "素材を削除", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "完成素材", exact: true }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: "ゴミ箱・復元", exact: true })
    .click();
  await panel.getByRole("button", { name: "完成素材", exact: true }).click();
  await panel.getByRole("button", { name: "素材を復元", exact: true }).click();
  await panel.getByRole("button", { name: "素材一覧へ", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "完成素材", exact: true }),
  ).toBeVisible();
  await input.setInputFiles({
    name: "corrupt.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  await expect(panel.getByRole("alert")).toContainText("取り込み失敗");
  await input.setInputFiles({
    name: "bad.png",
    mimeType: "text/plain",
    buffer: Buffer.from(data.png, "base64"),
  });
  await expect(panel.getByRole("alert")).toContainText("MIME");
  expect(await rows(page, "libraryFiles")).toHaveLength(2);
  await panel
    .getByRole("button", { name: "ライブラリーを閉じる", exact: true })
    .click();
  await page.reload();
  await openLibrary(page);
  expect(await rows(page, "libraryFiles")).toHaveLength(2);
});
test("T14/T15/T16: select library image, real branched crop/resize/adjust, save, retry, reuse and ZIP restore", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  const data = await imageFiles(page);
  let library = await openLibrary(page);
  await library
    .getByLabel("ライブラリーに画像を取り込む", { exact: true })
    .setInputFiles({
      name: "source.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from(data.jpeg, "base64"),
    });
  await expect(library.getByRole("status")).toContainText("1/1");
  await library
    .getByRole("button", { name: "ライブラリーを閉じる", exact: true })
    .click();
  await page.locator(".wf-palette summary").click();
  await page
    .locator(".wf-palette")
    .getByRole("button", { name: /^素材入力/ })
    .click();
  await page
    .getByRole("button", { name: "素材入力の設定", exact: true })
    .click();
  await page
    .getByRole("button", { name: "ライブラリーから画像を選ぶ", exact: true })
    .click();
  library = page.getByRole("dialog", { name: "素材ライブラリー", exact: true });
  await library
    .getByRole("button", { name: "この画像を選択：source.jpg", exact: true })
    .click();
  await expect(library).toHaveCount(0);
  await page.getByLabel("ノード設定を閉じる", { exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await rows<{
            document: { nodes: { config: { libraryRef?: unknown } }[] };
          }>(page, "workflows")
        )[0].document.nodes[0]?.config.libraryRef,
    )
    .toBeTruthy();
  const original = (await rows<LibraryVersion>(page, "libraryVersions"))[0];
  const resize = {
      ...newExecutionNode("image-resize"),
      config: { width: 64, height: 64 },
    },
    crop = {
      ...newExecutionNode("image-crop"),
      config: { width: 64, height: 64 },
    },
    adjust = { ...newExecutionNode("image-adjust"), id: crypto.randomUUID() },
    save = {
      ...newNode("save"),
      config: { name: "保存した加工結果" },
    };
  await page.evaluate(
    async ({ resize, crop, adjust, save }) => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open("axfluxo-workspace", 2);
        r.onsuccess = () => resolve(r.result);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("workflows", "readwrite"),
          s = tx.objectStore("workflows"),
          r = s.getAll();
        r.onsuccess = () => {
          const row = r.result[0],
            source = row.document.nodes[0];
          row.document.nodes.push(
            { ...resize, position: { x: 440, y: 80 } },
            { ...crop, position: { x: 440, y: 400 } },
            { ...adjust, position: { x: 800, y: 400 } },
            { ...save, position: { x: 1160, y: 400 } },
          );
          const ids: Record<string, string> = {
            resize: resize.id,
            crop: crop.id,
            adjust: adjust.id,
            save: save.id,
          };
          row.document.edges = [
            [source.id, "image", "resize", "in"],
            [source.id, "image", "crop", "in"],
            ["crop", "out", "adjust", "in"],
            ["adjust", "out", "save", "image"],
          ].map(([sourceNodeId, sourcePortId, targetNodeId, targetPortId]) => ({
            id: crypto.randomUUID(),
            sourceNodeId: ids[sourceNodeId] ?? sourceNodeId,
            sourcePortId,
            targetNodeId: ids[targetNodeId] ?? targetNodeId,
            targetPortId,
          }));
          s.put(row);
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { resize, crop, adjust, save },
  );
  await page.reload();
  await page
    .getByRole("button", { name: "実行パネルを開く", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Workflowを実行", exact: true })
    .click();
  await expect(page.locator(".run-panel")).toContainText(
    "実行状態: 成功 (5/5)",
  );
  let runs = await rows<Run>(page, "runs", true);
  const first = runs[0];
  const output = first.nodes[save.id].outputs!.out;
  expect(output.type).toBe("image");
  if (output.type !== "image") throw new Error("image required");
  expect(output.reference.scope).toBe("library");
  expect(await rows(page, "libraryFiles")).toHaveLength(2);
  expect(
    (await rows<LibraryVersion>(page, "libraryVersions")).find(
      (v) => v.id === original.id,
    )?.hash,
  ).toBe(original.hash);
  await page
    .getByRole("button", { name: "この入力で再実行", exact: true })
    .first()
    .click();
  await expect
    .poll(
      async () =>
        (await rows<Run>(page, "runs", true)).filter(
          (r) => r.state === "succeeded",
        ).length,
    )
    .toBe(2);
  expect(await rows(page, "libraryFiles")).toHaveLength(2);
  expect(await rows(page, "libraryReceipts")).toHaveLength(1);
  library = await openLibrary(page);
  await expect(
    library.getByRole("button", { name: "保存した加工結果", exact: true }),
  ).toBeVisible();
  await library
    .getByRole("button", { name: "ライブラリーを閉じる", exact: true })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Workflowバックアップ", exact: true })
    .click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  await page
    .locator('input[type="file"][accept*="zip"]')
    .last()
    .setInputFiles(path!);
  await expect(page.getByLabel("Workflow名", { exact: true })).toHaveValue(
    /復元/,
  );
  const count = (await rows(page, "workflows")).length;
  await page
    .locator('input[type="file"][accept*="zip"]')
    .last()
    .setInputFiles(path!);
  await expect(page.getByLabel("Workflow名", { exact: true })).toHaveValue(
    /復元/,
  );
  expect(await rows(page, "workflows")).toHaveLength(count);
  await page.reload();
  await page.locator(".wf-node-list summary").click();
  await page
    .getByRole("button", { name: "素材入力 の詳細", exact: true })
    .click();
  await page
    .getByRole("button", { name: "ライブラリーから画像を選ぶ", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "この画像を選択：保存した加工結果",
      exact: true,
    })
    .click();
  await page.getByLabel("ノード設定を閉じる", { exact: true }).click();
  await page
    .getByRole("button", { name: "実行パネルを開く", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Workflowを実行", exact: true })
    .click();
  await expect(page.locator(".run-panel")).toContainText(
    "実行状態: 成功 (5/5)",
  );
  runs = await rows<Run>(page, "runs", true);
  expect(
    runs.some((r) =>
      Object.values(r.snapshot.sources).some(
        (v) => JSON.stringify(v.reference) === JSON.stringify(output.reference),
      ),
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
