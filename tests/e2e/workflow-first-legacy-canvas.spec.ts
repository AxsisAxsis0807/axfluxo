import { expect, test } from "@playwright/test";
test("legacy canvas gestures and node placement stay scoped while the new canvas is hidden", async ({
  page,
  context,
}) => {
  await page.goto("./");
  await page
    .getByRole("button", { name: "旧Studioを開く", exact: true })
    .click();
  const legacy = page.locator(".legacy-workspace");
  await legacy.getByRole("button", { name: "Workflow", exact: true }).click();
  const region = legacy.getByRole("region", { name: "Workflow", exact: true });
  await region.getByText("＋ ノードを追加", { exact: true }).click();
  await region
    .getByRole("button", { name: "文章 設定のみ", exact: true })
    .click();
  const canvas = region.locator(".wf-canvas"),
    node = region.locator(".react-flow__node").first();
  await expect(node).toBeVisible();
  const bounds = (await canvas.boundingBox())!,
    box = (await node.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
  expect(box.y).toBeGreaterThanOrEqual(bounds.y - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  const matrix = () =>
    region.locator(".react-flow__viewport").evaluate((el) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { x: m.e, y: m.f, zoom: m.a };
    });
  const before = await matrix(),
    header = (await node.locator(".wf-drag").boundingBox())!,
    mid = {
      x: Math.round(header.x + header.width / 2),
      y: Math.round(header.y + header.height / 2),
    },
    graph = {
      x: (mid.x - bounds.x - before.x) / before.zoom,
      y: (mid.y - bounds.y - before.y) / before.zoom,
    };
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: mid.x - 30, y: mid.y, id: 1 },
      { x: mid.x + 30, y: mid.y, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: mid.x - 60, y: mid.y, id: 1 },
      { x: mid.x + 60, y: mid.y, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect.poll(async () => (await matrix()).zoom).toBeGreaterThan(1.5);
  const after = await matrix();
  expect((mid.x - bounds.x - after.x) / after.zoom).toBeCloseTo(graph.x, 0);
  expect((mid.y - bounds.y - after.y) / after.zoom).toBeCloseTo(graph.y, 0);
  await cdp.detach();
});
