import { test, expect, type Page } from "@playwright/test";
async function open(page: Page) {
  await page.goto("./");
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await expect(page.getByLabel("Workflow名", { exact: true })).toHaveValue(
    "無題のWorkflow",
  );
  return page.getByRole("region", { name: "Workflow", exact: true });
}
async function add(page: Page, name: string) {
  const summary = page.locator(".wf-palette summary");
  if (
    await page.locator(".wf-palette").evaluate((e) => !e.hasAttribute("open"))
  )
    await summary.click();
  await page
    .locator(".wf-palette")
    .getByRole("button", { name: `${name} 設定のみ`, exact: true })
    .click();
}
async function inspect(page: Page, name: string) {
  if (await page.getByLabel("ノード設定を閉じる").isVisible())
    await page.getByLabel("ノード設定を閉じる").click();
  const list = page.locator(".wf-node-list");
  if (await list.evaluate((e) => !e.hasAttribute("open")))
    await list.locator("summary").click();
  await list
    .getByRole("button", { name: `${name} の詳細`, exact: true })
    .click();
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("axfluxo-workflow", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const value = await new Promise<
      {
        document: import("../../src/domain/workflow/schema").WorkflowDocument;
      }[]
    >((resolve, reject) => {
      const r = db.transaction("workflows").objectStore("workflows").getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const prefs = await new Promise<
      { viewport: { x: number; y: number; zoom: number } }[]
    >((resolve, reject) => {
      const r = db
        .transaction("preferences")
        .objectStore("preferences")
        .getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return { docs: value.map((r) => r.document), viewport: prefs[0]?.viewport };
  });
}
test("Workflow fanout, config, undo/redo, reload and Studio coexist", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const region = await open(page);
  for (const name of ["素材入力", "素材を保存", "投稿する", "文章"])
    await add(page, name);
  await inspect(page, "素材入力");
  await page
    .getByRole("button", { name: "出力 → 画像 (image)", exact: true })
    .click();
  await inspect(page, "素材を保存");
  await page
    .getByRole("button", { name: "入力 ← 画像 (image)", exact: true })
    .click();
  await page.getByLabel("保存名", { exact: true }).fill("保存テスト");
  await page.getByLabel("保存名", { exact: true }).blur();
  await inspect(page, "素材入力");
  await page
    .getByRole("button", { name: "出力 → 画像 (image)", exact: true })
    .click();
  await inspect(page, "投稿する");
  await page
    .getByRole("button", { name: "入力 ← 画像 (image)", exact: true })
    .click();
  await page.getByLabel("ノード設定を閉じる").click();
  await region.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await region.getByRole("button", { name: "やり直す", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await region.getByRole("button", { name: "自動整列", exact: true }).click();
  await region.getByRole("button", { name: "全体表示", exact: true }).click();
  await expect(region.getByRole("status")).toHaveText("保存済み");
  const before = await stored(page);
  expect(before.docs[0].edges).toHaveLength(2);
  await page.reload();
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await inspect(page, "素材を保存");
  await expect(page.getByLabel("保存名", { exact: true })).toHaveValue(
    "保存テスト",
  );
  await expect(
    region.getByRole("button", { name: "実行（今後対応）", exact: true }),
  ).toBeDisabled();
  const after = await stored(page);
  expect(after.docs[0].nodes).toEqual(before.docs[0].nodes);
  expect(after.viewport).toEqual(before.viewport);
  await page.getByLabel("ノード設定を閉じる").click();
  await page.getByRole("button", { name: "スタジオ", exact: false }).click();
  await expect(page.getByLabel("プロジェクト名")).toBeVisible();
  expect(errors).toEqual([]);
});
test("two tabs refuse overwrite and allow a separate copy", async ({
  page,
  context,
}) => {
  const region = await open(page);
  await expect(region.getByRole("status")).toHaveText("保存済み");
  const second = await context.newPage();
  await open(second);
  await page.getByLabel("Workflow名", { exact: true }).fill("tab A");
  await page.getByLabel("Workflow名", { exact: true }).blur();
  await expect(region.getByRole("status")).toHaveText("保存済み");
  await second.getByLabel("Workflow名", { exact: true }).fill("tab B");
  await second.getByLabel("Workflow名", { exact: true }).blur();
  await expect(second.locator(".workflow").getByRole("status")).toHaveText(
    "競合・未保存",
  );
  await second
    .getByRole("button", { name: "別コピーとして保存", exact: true })
    .click();
  await expect(second.locator(".workflow").getByRole("status")).toHaveText(
    "保存済み",
  );
  expect((await stored(second)).docs.map((d) => d.name).sort()).toEqual([
    "tab A",
    "tab B コピー",
  ]);
});
test("wheel anchor, panel isolation, cancel recovery and viewport restore", async ({
  page,
}, info) => {
  const region = await open(page);
  await add(page, "文章");
  const canvas = page.locator(".wf-canvas"),
    box = (await canvas.boundingBox())!;
  const x = Math.round(box.x + box.width * 0.3),
    y = Math.round(box.y + box.height * 0.4);
  const transform = () =>
    page.locator(".react-flow__viewport").evaluate((e) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(e).transform);
      return { x: m.e, y: m.f, zoom: m.a };
    });
  const a = await transform();
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(250);
  const b = await transform();
  expect(b.zoom).toBeGreaterThan(a.zoom);
  expect((x - box.x - a.x) / a.zoom).toBeCloseTo((x - box.x - b.x) / b.zoom, 1);
  expect((y - box.y - a.y) / a.zoom).toBeCloseTo((y - box.y - b.y) / b.zoom, 1);
  await inspect(page, "文章");
  const panelBefore = await transform();
  await page
    .getByRole("textbox", { name: "文章", exact: true })
    .fill("panel input");
  await page.getByRole("textbox", { name: "文章", exact: true }).blur();
  expect(await transform()).toEqual(panelBefore);
  await page.getByLabel("ノード設定を閉じる").click();
  await canvas.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 30, { steps: 5 });
  await page.mouse.up();
  await expect(region.getByRole("status")).toHaveText("保存済み");
  const saved = (await stored(page)).viewport;
  await page.reload();
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await expect(region.getByRole("status")).toHaveText("保存済み");
  const restored = await transform();
  expect(restored.x).toBeCloseTo(saved.x, 1);
  expect(restored.y).toBeCloseTo(saved.y, 1);
  expect(restored.zoom).toBeCloseTo(saved.zoom, 2);
  await page.screenshot({
    path: `test-results/workflow-${info.project.name}.png`,
  });
});
test("pinch preserves midpoint and 1→2→1 touch returns to panning", async ({
  page,
  context,
}) => {
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
  await open(page);
  const box = (await page.locator(".wf-canvas").boundingBox())!;
  const x = box.x + box.width * 0.5,
    y = box.y + box.height * 0.5;
  const transform = () =>
    page.locator(".react-flow__viewport").evaluate((e) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(e).transform);
      return { x: m.e, y: m.f, z: m.a };
    });
  const touch = async (
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    points: { x: number; y: number; id: number }[],
  ) => session.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  await touch("touchStart", [{ x: x - 30, y, id: 1 }]);
  await touch("touchStart", [
    { x: x - 30, y, id: 1 },
    { x: x + 30, y, id: 2 },
  ]);
  const a = await transform();
  await touch("touchMove", [
    { x: x - 60, y, id: 1 },
    { x: x + 60, y, id: 2 },
  ]);
  await page.waitForTimeout(100);
  const b = await transform();
  expect(b.z).toBeGreaterThan(a.z);
  expect((x - box.x - a.x) / a.z).toBeCloseTo((x - box.x - b.x) / b.z, 1);
  expect((y - box.y - a.y) / a.z).toBeCloseTo((y - box.y - b.y) / b.z, 1);
  await touch("touchEnd", [{ x: x - 60, y, id: 1 }]);
  await touch("touchMove", [{ x: x - 40, y: y + 20, id: 1 }]);
  await touch("touchCancel", []);
  await touch("touchStart", [{ x, y, id: 3 }]);
  await touch("touchMove", [{ x: x + 30, y: y + 20, id: 3 }]);
  await touch("touchEnd", []);
  await expect.poll(async () => (await transform()).x).toBeGreaterThan(b.x);
  await expect.poll(async () => (await transform()).y).toBeGreaterThan(b.y);
  await session.detach();
});
test("header drag is one undo, duplicate/delete and keyboard details return focus", async ({
  page,
}) => {
  const region = await open(page);
  await add(page, "文章");
  const node = page.locator(".react-flow__node").first();
  const position = () =>
    node.evaluate((e) => (e as HTMLElement).style.transform);
  const initial = await position();
  const header = (await node.locator(".wf-drag").boundingBox())!;
  await page.mouse.move(header.x + 80, header.y + 20);
  await page.mouse.down();
  await page.mouse.move(header.x + 110, header.y + 60, { steps: 12 });
  await page.mouse.up();
  await expect.poll(position).not.toBe(initial);
  await region.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect.poll(position).toBe(initial);
  await region.getByRole("button", { name: "やり直す", exact: true }).click();
  const settings = node.getByRole("button", {
    name: "文章の設定",
    exact: true,
  });
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("ノード詳細設定")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await settings.click();
  await page.getByRole("button", { name: "複製", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await region.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
});
test("handle tap connects without drag and disconnect is keyboard accessible", async ({
  page,
}) => {
  const region = await open(page);
  await add(page, "素材入力");
  await add(page, "素材を保存");
  await region.getByRole("button", { name: "自動整列", exact: true }).click();
  await region.getByRole("button", { name: "全体表示", exact: true }).click();
  const out = page.locator('.react-flow__handle[data-handleid="image"].source');
  const input = page.locator(
    '.react-flow__handle[data-handleid="image"].target',
  );
  const start = (await out.boundingBox())!,
    end = (await input.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    (start.x + start.width / 2 + end.x + end.width / 2) / 2,
    (start.y + start.height / 2 + end.y + end.height / 2) / 2,
    { steps: 4 },
  );
  await page
    .locator(".wf-canvas")
    .dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await out.click();
  await input.click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await inspect(page, "素材を保存");
  const disconnect = page.getByRole("button", { name: /^接続解除 / });
  await disconnect.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await page.getByLabel("ノード設定を閉じる").click();
  await region.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
});
test("conflict reload replaces the draft and viewport without re-saving the stale document", async ({
  page,
  context,
}) => {
  const region = await open(page);
  await expect(region.getByRole("status")).toHaveText("保存済み");
  const second = await context.newPage();
  await open(second);
  await page.getByLabel("Workflow名", { exact: true }).fill("saved A");
  await page.getByLabel("Workflow名", { exact: true }).blur();
  const canvas = page.locator(".wf-canvas"),
    box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 80, { steps: 4 });
  await page.mouse.up();
  await expect(region.getByRole("status")).toHaveText("保存済み");
  const original = await stored(page);
  await second.getByLabel("Workflow名", { exact: true }).fill("stale B");
  await second.getByLabel("Workflow名", { exact: true }).blur();
  await expect(second.locator(".workflow").getByRole("status")).toHaveText(
    "競合・未保存",
  );
  await second
    .getByRole("button", {
      name: "保存版を再読込（現在の編集を破棄）",
      exact: true,
    })
    .click();
  await expect(second.getByLabel("Workflow名", { exact: true })).toHaveValue(
    "saved A",
  );
  await expect(second.locator(".workflow").getByRole("status")).toHaveText(
    "保存済み",
  );
  expect(await stored(second)).toEqual(original);
});

// Preserve the existing Studio/Phase 1 regression suite through its explicit legacy entry.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("axfluxo-view", "legacy"),
  );
});
