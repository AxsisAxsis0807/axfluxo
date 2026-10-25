import { expect, test, type Page } from "@playwright/test";
async function add(page: Page, name = "画像編集") {
  await page.getByRole("button", { name: "＋ 画像編集", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "画像編集ノード詳細" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("ノード名", { exact: true }).fill(name);
  await panel.getByLabel("入力方法", { exact: true }).selectOption("blank");
  return panel;
}
async function edit(page: Page, panel: ReturnType<Page["getByRole"]>) {
  await panel
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
}
async function closePanel(page: Page) {
  const close = page.getByLabel("設定を閉じる", { exact: true });
  if (await close.isVisible()) await close.click();
}
async function apply(page: Page) {
  await closePanel(page);
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "画像編集ノード詳細" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "画像編集ノード詳細" })
      .getByRole("button", { name: "画像エディターを開く", exact: true }),
  ).toBeFocused();
}
test("Workflow-first sessions persist, isolate nodes, render and restore a separate backup copy", async ({
  page,
}) => {
  await page.goto("./");
  await expect(
    page.getByLabel("Workflowワークスペース", { exact: true }),
  ).toBeVisible();
  let panel = await add(page, "ノードA");
  await edit(page, panel);
  await page.getByLabel("テキストを追加", { exact: true }).click();
  await page.getByLabel("文字入力", { exact: true }).fill("Aの独立した作品");
  await page.getByLabel("文字入力", { exact: true }).blur();
  await apply(page);
  panel = page.getByRole("complementary", { name: "画像編集ノード詳細" });
  await expect(panel.getByLabel("編集文書状態", { exact: true })).toContainText(
    "一致",
  );
  await panel
    .getByRole("button", { name: "出力画像を更新", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "出力画像をダウンロード", exact: true }),
  ).toBeVisible();
  await panel.getByLabel("ノード設定を閉じる", { exact: true }).click();
  panel = await add(page, "ノードB");
  await edit(page, panel);
  await page.getByLabel("図形を追加", { exact: true }).click();
  await apply(page);
  await page.getByLabel("ノード設定を閉じる", { exact: true }).click();
  await page.locator(".wf-node-list summary").click();
  await page
    .getByRole("button", { name: "ノードA の詳細", exact: true })
    .click();
  panel = page.getByRole("complementary", { name: "画像編集ノード詳細" });
  await edit(page, panel);
  await page.getByLabel("レイヤーを表示", { exact: true }).click();
  await page.locator(".layer-row").getByRole("button").first().click();
  await expect(page.getByLabel("文字入力", { exact: true })).toHaveValue(
    "Aの独立した作品",
  );
  await apply(page);
  await page.getByLabel("ノード設定を閉じる", { exact: true }).click();
  await page
    .locator(".wf-node-list")
    .evaluate((el) => el.setAttribute("open", ""));
  await page
    .getByRole("button", { name: "ノードA の詳細", exact: true })
    .click();
  await page
    .getByRole("button", { name: "出力画像を更新", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "出力画像をダウンロード", exact: true }),
  ).toBeVisible();
  await page.getByLabel("ノード設定を閉じる", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Workflowバックアップ", exact: true })
    .click();
  const file = await (await download).path();
  await page.locator('input[type=file][accept=".zip"]').setInputFiles(file!);
  await expect(page.getByLabel("Workflow名", { exact: true })).toHaveValue(
    /復元/,
  );
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page
    .getByRole("button", { name: "旧Studioを開く", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "次のアイデアを、ここから。" }),
  ).toBeVisible();
});
test("save failure keeps the editing session and retries safely", async ({
  page,
}) => {
  await page.goto("./");
  const panel = await add(page);
  await edit(page, panel);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    Object.defineProperty(window, "restorePut", {
      value: () => {
        IDBObjectStore.prototype.put = original;
      },
      configurable: true,
    });
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "editorDocuments")
        throw new DOMException("quota", "QuotaExceededError");
      return original.call(this, value, key);
    };
  });
  await page.getByLabel("図形を追加", { exact: true }).click();
  await closePanel(page);
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }).getByRole("alert"),
  ).toContainText("quota");
  await page.evaluate(() => {
    (window as unknown as { restorePut: () => void }).restorePut();
  });
  await page.getByRole("button", { name: "保存を再試行", exact: true }).click();
  await apply(page);
});
test("duplicate and delete Undo retain independent editor documents", async ({
  page,
}) => {
  await page.goto("./");
  let panel = await add(page, "元ノード");
  await edit(page, panel);
  await page.getByLabel("図形を追加", { exact: true }).click();
  await apply(page);
  panel = page.getByRole("complementary", { name: "画像編集ノード詳細" });
  await panel.getByRole("button", { name: "複製", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await panel.getByLabel("ノード設定を閉じる", { exact: true }).click();
  await page
    .locator(".react-flow__node")
    .last()
    .getByRole("button", { name: "画像編集の設定", exact: true })
    .click();
  panel = page.getByRole("complementary", { name: "画像編集ノード詳細" });
  await panel.getByLabel("ノード名", { exact: true }).fill("複製ノード");
  await edit(page, panel);
  await page.getByLabel("テキストを追加", { exact: true }).click();
  await apply(page);
  const layers = await page.evaluate(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const r = indexedDB.open("axfluxo-workspace", 1);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            q = db
              .transaction("editorDocuments")
              .objectStore("editorDocuments")
              .getAll();
          q.onsuccess = () => {
            db.close();
            resolve(q.result.map((row) => row.document.pages[0].layers.length));
          };
        };
      }),
  );
  expect(layers.sort()).toEqual([1, 2]);
  await page
    .getByRole("complementary", { name: "画像編集ノード詳細" })
    .getByRole("button", { name: "削除", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page
    .getByRole("region", { name: "Workflow", exact: true })
    .getByRole("button", { name: "元に戻す", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page
    .locator(".react-flow__node")
    .last()
    .getByRole("button", { name: "画像編集の設定", exact: true })
    .click();
  await edit(
    page,
    page.getByRole("complementary", { name: "画像編集ノード詳細" }),
  );
  await page.getByLabel("レイヤーを表示", { exact: true }).click();
  await expect(page.locator(".layer-row")).toHaveCount(2);
});
test("composition and invalid numbers block apply; browser Back retains the session", async ({
  page,
}) => {
  await page.goto("./");
  await edit(page, await add(page));
  await page.getByLabel("テキストを追加", { exact: true }).click();
  const text = page.getByLabel("文字入力", { exact: true });
  await text.dispatchEvent("compositionstart");
  await text.fill("変換中");
  await expect(page.locator(".session-bar").getByRole("status")).toHaveText(
    "入力未確定・未保存",
  );
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
  await text.dispatchEvent("compositionend");
  await text.blur();
  const width = page.getByLabel("幅", { exact: true });
  await width.fill("0");
  await expect(page.locator(".session-bar").getByRole("status")).toHaveText(
    "入力未確定・未保存",
  );
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
  await width.fill("600");
  await width.blur();
  await page.goBack();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }).getByRole("alert"),
  ).toContainText("保存してWorkflow");
  await apply(page);
});
test("new workspace two-tab conflict preserves both graph versions as independent copies", async ({
  page,
  context,
}) => {
  await page.goto("./");
  await add(page, "A");
  await expect(
    page
      .getByRole("region", { name: "Workflow", exact: true })
      .getByRole("status"),
  ).toHaveText("保存済み");
  const second = await context.newPage();
  await second.goto("./");
  await expect(second.locator(".react-flow__node")).toHaveCount(1);
  await page.getByLabel("Workflow名", { exact: true }).fill("先に保存");
  await expect(
    page
      .getByRole("region", { name: "Workflow", exact: true })
      .getByRole("status"),
  ).toHaveText("保存済み");
  await second.getByLabel("Workflow名", { exact: true }).fill("競合側");
  await expect(
    second
      .getByRole("region", { name: "Workflow", exact: true })
      .getByRole("status"),
  ).toHaveText("競合・未保存");
  await second
    .getByRole("button", { name: "別コピーとして保存", exact: true })
    .click();
  await expect(second.getByLabel("Workflow名", { exact: true })).toHaveValue(
    "競合側 コピー",
  );
  await page.reload();
  await expect(
    page.getByLabel("Workflowを選択", { exact: true }).locator("option"),
  ).toHaveCount(2);
});
async function png(page: Page, color: string) {
  return Buffer.from(
    await page.evaluate((c) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const context = canvas.getContext("2d")!;
      context.fillStyle = c;
      context.fillRect(0, 0, 64, 64);
      return [
        ...Uint8Array.from(atob(canvas.toDataURL().split(",")[1]), (x) =>
          x.charCodeAt(0),
        ),
      ];
    }, color),
  );
}
test("input change copies before replacing only the frozen input layer", async ({
  page,
}) => {
  await page.goto("./");
  const panel = await add(page, "固定入力");
  await page
    .locator('input[type=file][accept="image/png,image/jpeg,image/webp"]')
    .setInputFiles({
      name: "first.png",
      mimeType: "image/png",
      buffer: await png(page, "red"),
    });
  await expect(panel.getByLabel("入力方法", { exact: true })).toHaveValue(
    "selected",
  );
  await edit(page, panel);
  await page.getByLabel("テキストを追加", { exact: true }).click();
  await page.getByLabel("文字入力", { exact: true }).fill("維持する文字");
  await apply(page);
  const before = await page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const r = indexedDB.open("axfluxo-workspace", 1);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            q = db
              .transaction("editorDocuments")
              .objectStore("editorDocuments")
              .getAll();
          q.onsuccess = () => {
            db.close();
            resolve(q.result[0]);
          };
        };
      }),
  );
  await page
    .locator('input[type=file][accept="image/png,image/jpeg,image/webp"]')
    .setInputFiles({
      name: "second.png",
      mimeType: "image/png",
      buffer: await png(page, "blue"),
    });
  await editInputChange(page);
  await expect(
    page.getByRole("dialog", { name: "入力変更の選択" }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "コピー後に入力レイヤーのみ差し替え",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
  await apply(page);
  const records = await page.evaluate(
    () =>
      new Promise<
        {
          id: string;
          document: { pages: { layers: { kind: string; text?: string }[] }[] };
        }[]
      >((resolve, reject) => {
        const r = indexedDB.open("axfluxo-workspace", 1);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            q = db
              .transaction("editorDocuments")
              .objectStore("editorDocuments")
              .getAll();
          q.onsuccess = () => {
            db.close();
            resolve(q.result);
          };
        };
      }),
  );
  expect(records).toHaveLength(2);
  expect(records.find((r) => r.id === (before as { id: string }).id)).toEqual(
    before,
  );
  expect(
    records.every((r) =>
      r.document.pages[0].layers.some(
        (l) => l.kind === "text" && l.text === "維持する文字",
      ),
    ),
  ).toBe(true);
});
async function editInputChange(page: Page) {
  await page
    .getByRole("complementary", { name: "画像編集ノード詳細" })
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
}
test("connected unexecuted image processing is shown as ungenerated", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByText("＋ ノードを追加", { exact: true }).click();
  await page.getByRole("button", { name: /^画像処理/ }).click();
  await page
    .locator(".react-flow__node")
    .first()
    .getByRole("button", { name: "画像処理の設定", exact: true })
    .click();
  await page
    .getByRole("button", { name: "出力 → 画像 (image)", exact: true })
    .click();
  await page.getByLabel("ノード設定を閉じる", { exact: true }).click();
  const panel = await add(page);
  await panel.getByLabel("入力方法", { exact: true }).selectOption("connected");
  await panel
    .getByRole("button", { name: "入力 ← 元画像 (image)", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "画像エディターを開く", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Workflow", exact: true })
      .getByRole("alert"),
  ).toContainText("未生成");
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toHaveCount(0);
});
test("two simultaneous editor sessions detect draft CAS and save an independent copy", async ({
  page,
  context,
}) => {
  await page.goto("./");
  await edit(page, await add(page, "同じノード"));
  const second = await context.newPage();
  await second.goto("./");
  await second
    .locator(".react-flow__node")
    .getByRole("button", { name: "画像編集の設定", exact: true })
    .click();
  await edit(
    second,
    second.getByRole("complementary", { name: "画像編集ノード詳細" }),
  );
  await page.getByLabel("図形を追加", { exact: true }).click();
  await expect(page.locator(".session-bar").getByRole("status")).toHaveText(
    "保存済み",
  );
  await second.getByLabel("テキストを追加", { exact: true }).click();
  await expect(second.locator(".session-bar").getByRole("status")).toHaveText(
    "競合・未保存",
  );
  await closePanel(second);
  await second
    .getByRole("button", { name: "別コピーとして保存", exact: true })
    .click();
  await expect(
    second.getByRole("button", { name: "別コピーとして保存", exact: true }),
  ).toHaveCount(0);
  await expect(
    second.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
  await apply(second);
  await expect(second.locator(".react-flow__node")).toHaveCount(2);
  await page
    .getByRole("button", { name: "保存してWorkflowへ戻る", exact: true })
    .click();
  await expect(
    page.getByLabel("画像編集セッション", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "別コピーとして保存", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "別コピーとして保存", exact: true }),
  ).toHaveCount(0);
  await apply(page);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
});
