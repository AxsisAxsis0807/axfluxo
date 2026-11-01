import { test, expect } from "@playwright/test";
test("All Versions rollback keeps all five databases and never admits network work", async ({
  page,
}) => {
  const calls: string[] = [];
  page.on("request", (r) => {
    if (/\/projects\/|\/render-batches/.test(r.url())) calls.push(r.url());
  });
  await page.goto("developer/all-versions/");
  await expect(
    page.getByRole("heading", { name: "All Versions", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("入口はOFFです。projectと原本は保持されています。"),
  ).toBeVisible();
  const names = [
    "axfluxo",
    "axfluxo-workflow",
    "axfluxo-workspace",
    "axfluxo-execution",
    "axfluxo-developer",
  ];
  await page.evaluate(async (names) => {
    for (const name of names) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const q = indexedDB.open(name, name === "axfluxo-workspace" ? 2 : 1);
        q.onupgradeneeded = () => q.result.createObjectStore("keep");
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("keep", "readwrite");
        tx.objectStore("keep").put("unchanged", "original");
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    }
  }, names);
  await page.reload();
  await expect(
    page.getByText("入口はOFFです。projectと原本は保持されています。"),
  ).toBeVisible();
  expect(
    await page.evaluate(async (names) => {
      const values = [];
      for (const name of names) {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const q = indexedDB.open(name);
          q.onsuccess = () => resolve(q.result);
        });
        const value = await new Promise((resolve) => {
          const q = db.transaction("keep").objectStore("keep").get("original");
          q.onsuccess = () => resolve(q.result);
        });
        values.push([db.name, db.version, value]);
        db.close();
      }
      return values;
    }, names),
  ).toEqual(
    names.map((name) => [
      name,
      name === "axfluxo-workspace" ? 2 : 1,
      "unchanged",
    ]),
  );
  expect(calls).toEqual([]);
});
