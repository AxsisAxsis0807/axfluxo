import { expect, test } from "@playwright/test";

test("hidden Studio does not handle Workflow save shortcuts", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  const region = page.getByRole("region", { name: "Workflow", exact: true });
  await expect(region.getByRole("status")).toHaveText("保存済み");
  await region
    .locator("summary")
    .filter({ hasText: "ノード一覧・キーボード操作" })
    .focus();
  await page.evaluate(() => {
    // Installed after React's listener; observe whether Studio claimed this key.
    window.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "s" && event.ctrlKey)
        document.documentElement.dataset.studioClaimedSave = String(
          event.defaultPrevented,
        );
    });
  });
  await page.keyboard.press("Control+s");
  await expect(page.locator("html")).toHaveAttribute(
    "data-studio-claimed-save",
    "false",
  );
  const projects = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("axfluxo", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const count = db
            .transaction("projects")
            .objectStore("projects")
            .count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
        };
      }),
  );
  expect(projects).toBe(0);
});

// Preserve the existing Studio/Phase 1 regression suite through its explicit legacy entry.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("axfluxo-view", "legacy"),
  );
});
