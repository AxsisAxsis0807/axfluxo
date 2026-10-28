import { expect, test, type Page } from "@playwright/test";
import { newNode } from "../../src/domain/workflow/schema";
import { newExecutionNode } from "../../src/domain/workflow/execution-schema";
import type {
  WorkspaceDocument,
  EditorRecord,
} from "../../src/domain/workspace/schema";
import type { LibraryVersion } from "../../src/domain/library";

async function rows<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (store) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("axfluxo-workspace", 2);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise<T[]>((resolve, reject) => {
        const tx = db.transaction(store),
          request = tx.objectStore(store).getAll();
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, store);
}
async function graph(page: Page) {
  return (await rows<{ document: WorkspaceDocument }>(page, "workflows"))[0]
    .document;
}
async function closeEditorPanel(page: Page) {
  const close = page.getByLabel("設定を閉じる", { exact: true });
  if (await close.isVisible()) await close.click();
}
async function openEditor(page: Page) {
  await page
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
}
async function returnEditor(page: Page, draft = false) {
  await closeEditorPanel(page);
  await page
    .getByRole("button", {
      name: draft ? "適用せず作業版を保存して戻る" : "保存してWorkflowへ戻る",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("complementary", { name: "画像編集ノード詳細" }),
  ).toBeVisible();
}
async function inspect(page: Page, id: string) {
  const node = (await graph(page)).nodes.find((node) => node.id === id)!;
  const name = node.type === "image-edit" ? node.config.name : "素材入力";
  await page
    .locator(".wf-node-list")
    .evaluate((el) => el.setAttribute("open", ""));
  await page
    .getByRole("button", { name: `${name} の詳細`, exact: true })
    .click();
}

async function prepareUpstream(page: Page) {
  await page.getByLabel("ノード設定を閉じる", { exact: true }).click();
  await page
    .getByRole("button", { name: "実行パネルを開く", exact: true })
    .click();
  await page
    .getByRole("button", { name: "選択中の画像編集の上流を実行", exact: true })
    .click();
  await expect(page.locator(".run-panel")).toContainText(
    "実行状態: 成功 (2/2)",
  );
}

test("Phase 4 library → Studio → Workflow → adjust/save, draft isolation and input-change protection", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./");
  const bytes = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#b03050";
    ctx.fillRect(0, 0, 64, 64);
    const first = c.toDataURL().split(",")[1];
    ctx.fillStyle = "#20a090";
    ctx.fillRect(0, 0, 64, 64);
    return [first, c.toDataURL().split(",")[1]];
  });
  await page
    .getByRole("button", {
      name: "画像を取り込む・素材ライブラリー",
      exact: true,
    })
    .click();
  const library = page.getByRole("dialog", {
    name: "素材ライブラリー",
    exact: true,
  });
  await library
    .getByLabel("ライブラリーに画像を取り込む", { exact: true })
    .setInputFiles(
      bytes.map((data, i) => ({
        name: `input-${i}.png`,
        mimeType: "image/png",
        buffer: Buffer.from(data, "base64"),
      })),
    );
  await expect(library.getByRole("status")).toContainText("2/2");
  await library
    .getByRole("button", { name: "ライブラリーを閉じる", exact: true })
    .click();
  await page.getByRole("button", { name: "＋ 画像編集", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "画像編集ノード詳細" });
  await panel.getByLabel("入力方法", { exact: true }).selectOption("connected");
  await panel.getByLabel("ノード設定を閉じる", { exact: true }).click();
  await expect
    .poll(async () => (await graph(page)).nodes[0]?.config)
    .toMatchObject({ inputMode: "connected" });
  const versions = await rows<LibraryVersion>(page, "libraryVersions");
  const source = newNode("source"),
    resize = {
      ...newExecutionNode("image-resize"),
      config: { width: 128, height: 64 },
    },
    adjust = newExecutionNode("image-adjust"),
    save = newNode("save");
  save.config = { name: "Studioから保存" };
  const ref = (v: LibraryVersion) => ({
    scope: "library" as const,
    libraryId: v.libraryId,
    fileId: v.fileId,
    versionId: v.id,
    hash: v.hash,
    kind: "image" as const,
  });
  source.config = { libraryRef: ref(versions[0]) };
  await page.evaluate(
    async ({ source, resize, adjust, save }) => {
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
            editor = row.document.nodes[0];
          row.document.nodes.push(source, resize, adjust, save);
          row.document.edges = [
            [source.id, "image", resize.id, "in"],
            [resize.id, "out", editor.id, "in"],
            [editor.id, "out", adjust.id, "in"],
            [adjust.id, "out", save.id, "image"],
          ].map(([sourceNodeId, sourcePortId, targetNodeId, targetPortId]) => ({
            id: crypto.randomUUID(),
            sourceNodeId,
            sourcePortId,
            targetNodeId,
            targetPortId,
          }));
          s.put(row);
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { source, resize, adjust, save },
  );
  await page.reload();
  const original = await graph(page),
    editorId = original.nodes[0].id;
  await inspect(page, editorId);
  await prepareUpstream(page);
  expect(await rows(page, "libraryFiles")).toHaveLength(2); // No downstream save.
  expect(await rows(page, "editorRevisions")).toHaveLength(0);
  await inspect(page, editorId);
  await openEditor(page);
  await page.getByLabel("図形を追加", { exact: true }).click();
  await returnEditor(page, true);
  expect((await graph(page)).nodes[0].config).not.toHaveProperty(
    "appliedRevisionId",
  );
  let draft = (await rows<EditorRecord>(page, "editorDocuments"))[0];
  expect(draft.document.pages[0].layers).toHaveLength(2);
  const originalInput = draft.input!.reference;
  const fixed = (
    await rows<{ id: string; width: number; height: number }>(page, "assets")
  ).find((asset) => asset.id === originalInput.assetId);
  expect(fixed).toMatchObject({ width: 128, height: 64 });
  await openEditor(page);
  await returnEditor(page);
  const applied = (await graph(page)).nodes[0];
  expect(applied.config).toHaveProperty("appliedRevisionId");
  await openEditor(page);
  await page.getByLabel("テキストを追加", { exact: true }).click();
  await returnEditor(page, true);
  await expect(panel.getByLabel("編集文書状態", { exact: true })).toContainText(
    "未適用の変更",
  );
  expect((await graph(page)).nodes[0]).toEqual(applied);
  expect(await rows(page, "editorRevisions")).toHaveLength(1);
  await openEditor(page);
  await returnEditor(page);
  expect(await rows(page, "editorRevisions")).toHaveLength(2);
  await panel.getByLabel("ノード設定を閉じる", { exact: true }).click();
  await page
    .getByRole("button", { name: "実行パネルを開く", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Workflowを実行", exact: true })
    .click();
  await expect(page.locator(".run-panel")).toContainText(
    "実行状態: 成功 (5/5)",
  );
  expect(await rows(page, "libraryFiles")).toHaveLength(3);
  // A changed source must offer an explicit decision and preserve the original draft.
  await page.reload();
  await inspect(page, source.id);
  await page
    .getByRole("button", { name: "ライブラリーから画像を選ぶ", exact: true })
    .click();
  const second = versions[1];
  const files = await rows<{ id: string; name: string }>(page, "libraryFiles");
  const name = files.find((f) => f.id === second.fileId)!.name;
  await page
    .getByRole("button", { name: `この画像を選択：${name}`, exact: true })
    .click();
  await page.getByLabel("ノード設定を閉じる", { exact: true }).click();
  await inspect(page, editorId);
  await prepareUpstream(page);
  await inspect(page, editorId);
  await page
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  const choice = page.getByRole("dialog", { name: "入力変更の選択" });
  await expect(choice).toBeVisible();
  draft = (await rows<EditorRecord>(page, "editorDocuments"))[0];
  expect(draft.input?.reference).toEqual(originalInput);
  await choice
    .getByRole("button", {
      name: "コピー後に入力レイヤーのみ差し替え",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
  await returnEditor(page, true);
  const editors = await rows<EditorRecord>(page, "editorDocuments");
  expect(editors).toHaveLength(2);
  expect(editors.find((e) => e.id === draft.id)).toEqual(draft);
  expect(
    editors.find((e) => e.id !== draft.id)?.input?.reference.hash,
  ).not.toBe(originalInput.hash);
  expect(
    editors.find((e) => e.id !== draft.id)?.document.pages[0].layers,
  ).toHaveLength(3);
  await panel.getByLabel("ノード設定を閉じる", { exact: true }).click();
  await page
    .getByRole("button", { name: "新しいWorkflow", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.locator(".wf-palette summary").click();
  await page
    .locator(".wf-palette")
    .getByRole("button", { name: /^素材入力/ })
    .click();
  await page.locator(".react-flow__node").getByRole("button").click();
  await page
    .getByRole("button", { name: "ライブラリーから画像を選ぶ", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "この画像を選択：Studioから保存",
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
    "実行状態: 成功 (1/1)",
  );
  expect(await rows(page, "libraryFiles")).toHaveLength(3);
  expect(errors).toEqual([]);
});

test("Phase 4 draft-only return stays open on failed save and retries without applying", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("button", { name: "＋ 画像編集", exact: true }).click();
  await page.getByLabel("入力方法", { exact: true }).selectOption("blank");
  await openEditor(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    Object.defineProperty(window, "restorePhase4Put", {
      value: () => {
        IDBObjectStore.prototype.put = original;
      },
    });
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "editorDocuments")
        throw new DOMException("phase4 quota", "QuotaExceededError");
      return original.call(this, value, key);
    };
  });
  await page.getByLabel("図形を追加", { exact: true }).click();
  await closeEditorPanel(page);
  await page
    .getByRole("button", { name: "適用せず作業版を保存して戻る", exact: true })
    .click();
  const session = page.getByLabel("画像編集セッション", { exact: true });
  await expect(session).toBeVisible();
  await expect(session.getByRole("alert")).toContainText("phase4 quota");
  await page.evaluate(() =>
    (window as unknown as { restorePhase4Put: () => void }).restorePhase4Put(),
  );
  await page.getByRole("button", { name: "保存を再試行", exact: true }).click();
  await returnEditor(page, true);
  expect(await rows(page, "editorRevisions")).toHaveLength(0);
  expect(
    (await rows<EditorRecord>(page, "editorDocuments"))[0].document.pages[0]
      .layers,
  ).toHaveLength(1);
});
