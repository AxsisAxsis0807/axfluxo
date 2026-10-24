import { test, expect, type Page } from "@playwright/test";
import type { WorkflowDocument } from "../../src/domain/workflow/schema";
async function start(page: Page, type = "文章") {
  await page.goto("./");
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  const region = page.getByRole("region", { name: "Workflow", exact: true });
  await expect(region.getByRole("status")).toHaveText("保存済み");
  await page.locator(".wf-palette summary").click();
  await page
    .locator(".wf-palette")
    .getByRole("button", { name: `${type} 設定のみ`, exact: true })
    .click();
  await page.locator(".wf-node-list summary").click();
  await page
    .locator(".wf-node-list")
    .getByRole("button", { name: `${type} の詳細`, exact: true })
    .click();
  await expect(region.getByRole("status")).toHaveText("保存済み");
  return region;
}
async function documents(page: Page): Promise<WorkflowDocument[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("axfluxo-workflow", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const rows = await new Promise<{ document: WorkflowDocument }[]>(
      (resolve, reject) => {
        const r = db.transaction("workflows").objectStore("workflows").getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      },
    );
    db.close();
    return rows.map((r) => r.document);
  });
}
test("review: valid config autosaves while the field stays focused and native undo stays local", async ({
  page,
}) => {
  const region = await start(page);
  const input = page.getByRole("textbox", { name: "文章", exact: true });
  await input.fill("入力中の文章");
  await expect
    .poll(async () => (await documents(page))[0].nodes[0].config)
    .toEqual({ text: "入力中の文章" });
  await expect(input).toBeFocused();
  await expect(region.getByRole("status")).toHaveText("保存済み");
  await input.pressSequentially("abc");
  const beforeUndo = await input.inputValue();
  await input.press("ControlOrMeta+z");
  await expect(input).not.toHaveValue(beforeUndo);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(input).toBeFocused();
  await input.blur();
  await page.getByLabel("ノード設定を閉じる").click();
  await region.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
});
test("review: invalid config is unsaved and correcting it clears the error", async ({
  page,
}) => {
  const region = await start(page, "画像処理");
  const width = page.getByLabel("幅", { exact: true });
  await width.fill("0");
  await width.blur();
  await expect(region.getByRole("alert")).toBeVisible();
  await expect(region.getByRole("status")).not.toHaveText("保存済み");
  expect((await documents(page))[0].nodes[0].config).toEqual({
    operation: "resize",
    width: 1080,
  });
  await width.fill("640");
  await width.blur();
  await expect(region.getByRole("status")).toHaveText("保存済み");
  await expect(region.getByRole("alert")).toHaveCount(0);
});
test("review: recovery cannot discard a pending edit", async ({ page }) => {
  const region = await start(page);
  await page.getByLabel("ノード設定を閉じる").click();
  await region.getByRole("button", { name: "復旧履歴", exact: true }).click();
  await expect(
    region.getByRole("button", { name: /をコピー復旧/ }).first(),
  ).toBeVisible();
  await page.getByLabel("Workflow名", { exact: true }).fill("保存待ちの編集");
  await expect(
    region.getByRole("button", { name: /をコピー復旧/ }).first(),
  ).toBeDisabled();
  await expect(region.getByRole("status")).toHaveText("保存済み");
  await region
    .getByRole("button", { name: /をコピー復旧/ })
    .first()
    .click();
  await expect(region.getByRole("status")).toHaveText("保存済み");
  const docs = await documents(page);
  expect(docs).toHaveLength(2);
  expect(docs.some((d) => d.name === "保存待ちの編集")).toBe(true);
});
test("review: real touch taps and drag connect ports after disconnect", async ({
  page,
  context,
}) => {
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
  await start(page, "素材入力");
  await page.getByLabel("ノード設定を閉じる").click();
  await page.locator(".wf-palette summary").click();
  await page
    .locator(".wf-palette")
    .getByRole("button", { name: "素材を保存 設定のみ", exact: true })
    .click();
  await page.getByRole("button", { name: "自動整列", exact: true }).click();
  await page.getByRole("button", { name: "全体表示", exact: true }).click();
  const source = page.locator(".react-flow__handle.source"),
    target = page.locator(".react-flow__handle.target");
  const tap = async (locator: typeof source) => {
    const b = (await locator.boundingBox())!;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  };
  await tap(source);
  await tap(target);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await page
    .locator(".wf-node-list")
    .getByRole("button", { name: "素材を保存 の詳細", exact: true })
    .click();
  await page.getByRole("button", { name: /^接続解除 / }).click();
  await page.getByLabel("ノード設定を閉じる").click();
  const a = (await source.boundingBox())!,
    b = (await target.boundingBox())!;
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: a.x + a.width / 2, y: a.y + a.height / 2, id: 2 }],
  });
  for (let i = 1; i <= 8; i++)
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x:
            a.x +
            a.width / 2 +
            ((b.x + b.width / 2 - a.x - a.width / 2) * i) / 8,
          y:
            a.y +
            a.height / 2 +
            ((b.y + b.height / 2 - a.y - a.height / 2) * i) / 8,
          id: 2,
        },
      ],
    });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await session.detach();
});
test("review: a header drag survives 1→2→1 touches and lost capture without a node jump", async ({
  page,
  context,
}) => {
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
  await start(page);
  await page.getByLabel("ノード設定を閉じる").click();
  const header = page.locator(".wf-drag"),
    node = page.locator(".react-flow__node");
  const box = (await header.boundingBox())!,
    x = box.x + 80,
    y = box.y + 20;
  const position = () =>
    node.evaluate((e) => (e as HTMLElement).style.transform);
  const touch = (
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    points: { x: number; y: number; id: number }[],
  ) => session.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  await expect(header).toBeVisible();
  const initial = await position();
  await touch("touchStart", [{ x, y, id: 1 }]);
  for (let i = 1; i <= 8; i++)
    await touch("touchMove", [{ x: x + 4 * i, y: y + 3 * i, id: 1 }]);
  await expect(node).toBeVisible();
  await expect.poll(position).not.toBe(initial);
  const moved = await position();
  const viewport = () =>
    page.locator(".react-flow__viewport").evaluate((e) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(e).transform);
      return { x: m.e, y: m.f, zoom: m.a };
    });
  const beforePinch = await viewport(),
    canvas = (await page.locator(".wf-canvas").boundingBox())!;
  await touch("touchStart", [
    { x: x + 32, y: y + 24, id: 1 },
    { x: x + 65, y: y + 24, id: 2 },
  ]);
  await touch("touchMove", [
    { x: x + 27, y: y + 19, id: 1 },
    { x: x + 75, y: y + 29, id: 2 },
  ]);
  await expect
    .poll(async () => (await viewport()).zoom)
    .toBeGreaterThan(beforePinch.zoom);
  const afterPinch = await viewport();
  expect((x + 48.5 - canvas.x - beforePinch.x) / beforePinch.zoom).toBeCloseTo(
    (x + 51 - canvas.x - afterPinch.x) / afterPinch.zoom,
    1,
  );
  expect((y + 24 - canvas.y - beforePinch.y) / beforePinch.zoom).toBeCloseTo(
    (y + 24 - canvas.y - afterPinch.y) / afterPinch.zoom,
    1,
  );
  await touch("touchEnd", [{ x: x + 27, y: y + 19, id: 1 }]);
  await touch("touchMove", [{ x: x + 42, y: y + 29, id: 1 }]);
  await touch("touchCancel", []);
  await expect.poll(position).toBe(moved);
  await page
    .locator(".wf-canvas")
    .dispatchEvent("pointerdown", { pointerId: 9 });
  await page
    .locator(".wf-canvas")
    .dispatchEvent("lostpointercapture", { pointerId: 9 });
  const next = (await header.boundingBox())!;
  await touch("touchStart", [{ x: next.x + 60, y: next.y + 20, id: 3 }]);
  for (let i = 1; i <= 8; i++)
    await touch("touchMove", [
      { x: next.x + 60 + 4 * i, y: next.y + 20 + 2 * i, id: 3 },
    ]);
  await touch("touchEnd", []);
  await expect.poll(position).not.toBe(moved);
  await session.detach();
});
test("review: config undo/redo updates the existing field and survives reload", async ({
  page,
}) => {
  const region = await start(page),
    input = page.getByRole("textbox", { name: "文章", exact: true });
  await input.fill("first");
  await expect
    .poll(async () => (await documents(page))[0].nodes[0].config)
    .toEqual({ text: "first" });
  await input.fill("second");
  await expect
    .poll(async () => (await documents(page))[0].nodes[0].config)
    .toEqual({ text: "second" });
  await page.getByLabel("ノード設定を閉じる").click();
  await region.getByRole("button", { name: "元に戻す", exact: true }).click();
  await page
    .locator(".wf-node-list")
    .getByRole("button", { name: "文章 の詳細", exact: true })
    .click();
  await expect(input).toHaveValue("first");
  await page.getByLabel("ノード設定を閉じる").click();
  await region.getByRole("button", { name: "やり直す", exact: true }).click();
  await expect(region.getByRole("status")).toHaveText("保存済み");
  await page.reload();
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await page.locator(".wf-node-list summary").click();
  await page
    .locator(".wf-node-list")
    .getByRole("button", { name: "文章 の詳細", exact: true })
    .click();
  await expect(input).toHaveValue("second");
});
test("review: quota failure retains normal data and retry clears its stale error", async ({
  page,
}) => {
  const region = await start(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let fail = true;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<typeof original>
    ) {
      if (fail && this.name === "preferences") {
        fail = false;
        throw new DOMException("review quota", "QuotaExceededError");
      }
      return original.apply(this, args);
    };
  });
  await page
    .getByRole("textbox", { name: "文章", exact: true })
    .fill("recovered");
  await expect(region.getByRole("status")).toHaveText("保存失敗・未保存");
  await expect(region.getByRole("alert")).toContainText("review quota");
  expect((await documents(page))[0].nodes[0].config).toEqual({ text: "" });
  await region
    .getByRole("button", { name: "保存を再試行", exact: true })
    .click();
  await expect(region.getByRole("status")).toHaveText("保存済み");
  await expect(region.getByRole("alert")).toHaveCount(0);
  expect((await documents(page))[0].nodes[0].config).toEqual({
    text: "recovered",
  });
});
test("review: composition stays unsaved until confirmation without replacing the field", async ({
  page,
}) => {
  const region = await start(page),
    input = page.getByRole("textbox", { name: "文章", exact: true });
  await input.focus();
  await input.dispatchEvent("compositionstart");
  await input.fill("日本語の変換中");
  await expect(region.getByRole("status")).toHaveText("入力未確定・未保存");
  expect((await documents(page))[0].nodes[0].config).toEqual({ text: "" });
  await input.dispatchEvent("compositionend", { data: "日本語の変換中" });
  await expect(region.getByRole("status")).toHaveText("保存済み");
  await expect(input).toBeFocused();
  expect((await documents(page))[0].nodes[0].config).toEqual({
    text: "日本語の変換中",
  });
});
