import { expect, test, type Page } from "@playwright/test";
import { newNode } from "../../src/domain/workflow/schema";
import { newExecutionNode } from "../../src/domain/workflow/execution-schema";
import {
  newWorkspace,
  newImageEdit,
} from "../../src/services/workspace/repository";
import type { Run, Output } from "../../src/domain/workflow/execution";
const edge = (
  a: { id: string },
  b: { id: string },
  sourcePortId: string,
  targetPortId: string,
) => ({
  id: crypto.randomUUID(),
  sourceNodeId: a.id,
  sourcePortId,
  targetNodeId: b.id,
  targetPortId,
});
async function seed(page: Page, mode: "images" | "edit" = "images") {
  const assetId = crypto.randomUUID(),
    source = newNode("source"),
    resize = newExecutionNode("image-resize"),
    crop = newExecutionNode("image-crop"),
    adjust = newExecutionNode("image-adjust"),
    pack = newExecutionNode("collection-pack"),
    order = newExecutionNode("collection-order"),
    item = newExecutionNode("collection-item"),
    number = newExecutionNode("number"),
    text = newNode("text");
  source.config = { assetId };
  resize.config = { width: 128, height: 64 };
  crop.config = { width: 64, height: 64 };
  adjust.config = { brightness: 1, contrast: 1, saturation: 0 };
  number.config = { value: 42 };
  text.config = { text: "固定した文章" };
  order.config = { reverse: true };
  item.config = { index: 0 };
  const pair = newImageEdit(),
    revisionId = crypto.randomUUID();
  pair.node.config = {
    ...pair.node.config,
    inputMode: "blank",
    appliedRevisionId: revisionId,
    outputPageId: pair.editor.document.pages[0].id,
  };
  pair.editor.document.pages[0].width = 128;
  pair.editor.document.pages[0].height = 128;
  pair.editor.document.pages[0].background = "#ff0000";
  pair.editor.document.pages[0].alpha = 1;
  const graph =
    mode === "edit"
      ? { ...newWorkspace(), nodes: [pair.node], edges: [] }
      : {
          ...newWorkspace(),
          nodes: [
            source,
            resize,
            crop,
            adjust,
            pack,
            order,
            item,
            number,
            text,
          ],
          edges: [
            edge(source, resize, "image", "in"),
            edge(source, crop, "image", "in"),
            edge(crop, adjust, "out", "in"),
            edge(resize, pack, "out", "first"),
            edge(adjust, pack, "out", "second"),
            edge(pack, order, "out", "in"),
            edge(order, item, "out", "in"),
          ],
        };
  await page.goto("./");
  await expect(page.getByLabel("Workflow名", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Workflowを選択", { exact: true })).toHaveValue(
    /^[a-f0-9-]{36}$/,
  );
  await page.evaluate(
    async ({ graph, assetId, pair, revisionId }) => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open("axfluxo-workspace", 1);
        request.onsuccess = () => resolve(request.result);
      });
      const rows = await new Promise<{ id: string }[]>((resolve) => {
        const request = db
          .transaction("workflows")
          .objectStore("workflows")
          .getAll();
        request.onsuccess = () => resolve(request.result);
      });
      graph.workflowId = rows[0].id;
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 64;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#ff0000";
      context.fillRect(0, 0, 64, 64);
      context.fillStyle = "#0000ff";
      context.fillRect(64, 0, 64, 64);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), "image/png"),
      );
      canvas.width = canvas.height = 0;
      const hash = [
        ...new Uint8Array(
          await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
        ),
      ]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          ["workflows", "assets", "editorDocuments", "editorRevisions"],
          "readwrite",
        );
        tx.objectStore("workflows").put({
          id: graph.workflowId,
          document: graph,
        });
        tx.objectStore("assets").add({
          id: assetId,
          name: "original.png",
          hash,
          blob,
          original: blob,
          mime: "image/png",
          blobMime: "image/png",
          originalMime: "image/png",
          width: 128,
          height: 64,
        });
        if (graph.nodes[0].type === "image-edit") {
          tx.objectStore("editorDocuments").add(pair.editor);
          const editor = {
            id: pair.editor.id,
            document: pair.editor.document,
            assets: pair.editor.assets,
            updatedAt: pair.editor.updatedAt,
          };
          tx.objectStore("editorRevisions").add({
            ...editor,
            id: revisionId,
            editorDocumentId: pair.editor.id,
          });
        }
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { graph, assetId, pair, revisionId },
  );
  await page.reload();
  await expect(page.getByLabel("Workflow名", { exact: true })).toBeVisible();
  return {
    source,
    resize,
    crop,
    adjust,
    pack,
    order,
    item,
    number,
    text,
    pair,
    assetId,
  };
}
async function runs(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("axfluxo-execution", 1);
      request.onsuccess = () => resolve(request.result);
    });
    const rows = await new Promise<Run[]>((resolve) => {
      const request = db.transaction("runs").objectStore("runs").getAll();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });
}
async function openRun(page: Page) {
  await page.locator(".run-panel > summary").click();
}
test("T07/T11: real image DAG shares original, processes dimensions/color, preserves collection order and uses cache for ten runs", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await seed(page);
  await page.evaluate(() => {
    const counter = { urls: 0 };
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      counter.urls++;
      return create(blob);
    };
    URL.revokeObjectURL = (url) => {
      counter.urls--;
      revoke(url);
    };
    (window as typeof window & { resources?: typeof counter }).resources =
      counter;
  });
  await openRun(page);
  const runButton = page.getByRole("button", {
    name: "Workflowを実行",
    exact: true,
  });
  for (let index = 0; index < 10; index++) {
    await runButton.click();
    await expect(page.locator(".run-panel")).toContainText(
      "実行状態: 成功 (9/9)",
    );
    await expect(runButton).toBeEnabled();
  }
  const history = await runs(page);
  expect(history).toHaveLength(10);
  const first = history[0],
    last = history[9];
  expect(first.nodes[f.number.id].outputs?.number).toEqual({
    type: "number",
    value: 42,
  });
  expect(first.nodes[f.text.id].outputs?.text).toEqual({
    type: "text",
    value: "固定した文章",
  });
  const ordered = first.nodes[f.order.id].outputs!.out;
  expect(ordered.type).toBe("collection<image>");
  if (ordered.type !== "collection<image>") throw new Error("wrong collection");
  expect(ordered.items.map((v) => [v.width, v.height])).toEqual([
    [64, 64],
    [128, 64],
  ]);
  expect(first.nodes[f.item.id].outputs?.out).toEqual(ordered.items[0]);
  const result = await page.evaluate(
    async ({ first, last, assetId }) => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open("axfluxo-execution", 1);
        r.onsuccess = () => resolve(r.result);
      });
      const read = <T>(store: string) =>
        new Promise<T[]>((resolve) => {
          const r = db.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => resolve(r.result);
        });
      const outputs = await read<Output>("outputs"),
        attempts = await read<{ runId: string; cacheHit?: boolean }>(
          "attempts",
        );
      db.close();
      const pixels = [];
      for (const output of outputs) {
        const bitmap = await createImageBitmap(output.blob),
          canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        pixels.push({
          width: bitmap.width,
          height: bitmap.height,
          pixel: [...context.getImageData(0, 0, 1, 1).data],
        });
        bitmap.close();
        canvas.width = canvas.height = 0;
      }
      const workspace = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open("axfluxo-workspace", 1);
        r.onsuccess = () => resolve(r.result);
      });
      const original = await new Promise<{ hash: string; original: Blob }>(
        (resolve) => {
          const r = workspace
            .transaction("assets")
            .objectStore("assets")
            .get(assetId);
          r.onsuccess = () => resolve(r.result);
        },
      );
      workspace.close();
      const hash = [
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            await original.original.arrayBuffer(),
          ),
        ),
      ]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      return {
        count: outputs.length,
        pixels,
        originalUnchanged: original.hash === hash,
        cacheHit: attempts
          .filter((a) => a.runId === last.id)
          .every((a) => a.cacheHit),
        firstHit: attempts
          .filter((a) => a.runId === first.id)
          .every((a) => a.cacheHit),
      };
    },
    { first, last, assetId: f.assetId },
  );
  expect(result.count).toBe(3);
  expect(result.originalUnchanged).toBe(true);
  expect(result.cacheHit).toBe(true);
  expect(result.firstHit).toBe(false);
  const gray = result.pixels.find(
    (p) =>
      p.width === 64 && p.pixel[0] === p.pixel[1] && p.pixel[1] === p.pixel[2],
  );
  expect(gray).toBeDefined();
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { resources?: { urls: number } }).resources
          ?.urls,
    ),
  ).toBe(0);
  expect(errors).toEqual([]);
  await page.reload();
  await openRun(page);
  await expect(page.locator(".run-panel")).toContainText(
    "実行状態: 成功 (9/9)",
  );
  await page
    .getByRole("button", { name: "キャッシュを破棄（履歴の結果は保持）" })
    .click();
  expect(await runs(page)).toHaveLength(10);
});
test("image-edit run matches the existing applied-revision output renderer", async ({
  page,
}) => {
  const f = await seed(page, "edit");
  await openRun(page);
  await page
    .getByRole("button", { name: "Workflowを実行", exact: true })
    .click();
  await expect(page.locator(".run-panel")).toContainText(
    "実行状態: 成功 (1/1)",
  );
  const run = (await runs(page))[0],
    value = run.nodes[f.pair.node.id].outputs!.out;
  expect(value.type).toBe("image");
  await page.locator(".run-panel > summary").click();
  const list = page.locator(".wf-node-list");
  await list.locator("summary").click();
  await list
    .getByRole("button", { name: "画像編集 の詳細", exact: true })
    .click();
  const panel = page.getByRole("complementary", { name: "画像編集ノード詳細" });
  await panel
    .getByRole("button", {
      name: "出力画像を更新",
      exact: true,
    })
    .click();
  await expect(panel).toContainText("出力生成済み");
  const artifacts = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("axfluxo-workspace", 1);
      r.onsuccess = () => resolve(r.result);
    });
    const values = await new Promise<{ hash: string }[]>((resolve) => {
      const r = db.transaction("artifacts").objectStore("artifacts").getAll();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return values;
  });
  if (value.type === "image") expect(artifacts[0].hash).toBe(value.hash);
});

test("T10: encode cancellation publishes no late result; reload marks interrupted without restarting", async ({
  page,
}) => {
  await seed(page);
  await openRun(page);
  await page.evaluate(() => {
    const target = window as typeof window & {
      encodeWaiting?: boolean;
      releaseEncode?: () => void;
    };
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      original.call(
        this,
        (blob) => {
          target.encodeWaiting = true;
          target.releaseEncode = () => callback(blob);
        },
        ...args,
      );
    };
  });
  await page
    .getByRole("button", { name: "Workflowを実行", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!(window as typeof window & { encodeWaiting?: boolean })
            .encodeWaiting,
      ),
    )
    .toBe(true);
  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect(other.getByLabel("Workflow名", { exact: true })).toBeVisible();
  await openRun(other);
  await expect(other.locator(".run-panel")).toContainText("実行状態: 実行中");
  await other
    .getByRole("button", { name: "Workflowを実行", exact: true })
    .click();
  await expect(other.locator(".run-panel")).toContainText(
    "別のタブで実行中です",
  );
  expect(await runs(other)).toHaveLength(1);
  await other.close();
  await page.getByRole("button", { name: "実行を中断", exact: true }).click();
  await page.evaluate(() =>
    (
      window as typeof window & { releaseEncode?: () => void }
    ).releaseEncode?.(),
  );
  await expect(page.locator(".run-panel")).toContainText("実行状態: 中断");
  const history = await runs(page);
  expect(history).toHaveLength(1);
  expect(
    Object.values(history[0].nodes).some((node) => node.state === "cancelled"),
  ).toBe(true);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("axfluxo-execution", 1);
      r.onsuccess = () => resolve(r.result);
    });
    const tx = db.transaction(["runs", "attempts", "outputs"], "readwrite");
    const outputs = tx.objectStore("outputs").count();
    outputs.onsuccess = () => {
      if (outputs.result !== 0) tx.abort();
    };
    const rows = tx.objectStore("runs").getAll();
    rows.onsuccess = () => {
      const run = rows.result[0];
      run.state = "running";
      for (const node of Object.values(run.nodes) as { state: string }[])
        node.state = "running";
      tx.objectStore("runs").put(run);
    };
    const attempts = tx.objectStore("attempts").getAll();
    attempts.onsuccess = () => {
      const a = attempts.result[0];
      a.state = "running";
      tx.objectStore("attempts").put(a);
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error("late output was published"));
    });
    db.close();
  });
  await page.reload();
  await openRun(page);
  await expect(page.locator(".run-panel")).toContainText(
    "前回の実行が途切れました",
  );
  expect(await runs(page)).toHaveLength(1);
});
