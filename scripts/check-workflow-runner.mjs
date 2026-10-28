import { existsSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
const enabledBase = new URL(
  process.env.WORKFLOW_RUNNER_URL || "http://127.0.0.1:3180/",
).href;
const disabledBase = new URL(
  process.env.WORKFLOW_RUNNER_OFF_URL || "http://127.0.0.1:3182/",
).href;
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(enabledBase);
    await expect(page.getByLabel("Workflow名", { exact: true })).toBeVisible();
    await page.getByText("＋ 実行ノードを追加", { exact: true }).click();
    await page.getByRole("button", { name: "数値入力", exact: true }).click();
    const inspector = page.getByRole("complementary", {
      name: "実行ノード設定",
    });
    await inspector.getByLabel("数値", { exact: true }).fill("42");
    await inspector
      .getByRole("button", { name: "閉じる", exact: true })
      .click();
    await page.locator(".run-panel > summary").click();
    await page
      .getByRole("button", { name: "Workflowを実行", exact: true })
      .click();
    await expect(page.locator(".run-panel")).toContainText(
      "実行状態: 成功 (1/1)",
    );
    const read = async () =>
      page.evaluate(async () => {
        const rows = async (name, store) => {
          const db = await new Promise((resolve) => {
            const r = indexedDB.open(
              name,
              name === "axfluxo-workspace" ? 2 : 1,
            );
            r.onsuccess = () => resolve(r.result);
          });
          const result = await new Promise((resolve) => {
            const r = db.transaction(store).objectStore(store).getAll();
            r.onsuccess = () => resolve(r.result);
          });
          db.close();
          return result;
        };
        return {
          workflows: await rows("axfluxo-workspace", "workflows"),
          runs: await rows("axfluxo-execution", "runs"),
        };
      });
    const before = await read();
    await page.route(`${enabledBase}**`, async (route) => {
      const url = route.request().url().replace(enabledBase, disabledBase);
      const response = await route.fetch({ url });
      await route.fulfill({ response });
    });
    await page.reload();
    await expect(page.getByLabel("Workflow名", { exact: true })).toBeVisible();
    await expect(page.locator(".run-panel")).toHaveCount(0);
    expect(await read()).toEqual(before);
    await page.locator(".wf-node-list > summary").click();
    await page
      .locator(".wf-node-list")
      .getByRole("button", { name: "数値入力 の詳細", exact: true })
      .click();
    await expect(
      page
        .getByRole("complementary", { name: "実行ノード設定" })
        .getByLabel("数値", { exact: true }),
    ).toHaveValue("42");
    await page.unroute(`${enabledBase}**`);
    await page.reload();
    await expect(page.locator(".run-panel")).toHaveCount(1);
    expect(await read()).toEqual(before);
    await context.close();
    console.log(`runner flag roundtrip: ${viewport.width}px PASS`);
  }
} finally {
  await browser.close();
}
