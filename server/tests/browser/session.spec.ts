import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [new URL("refresh-fixture.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: {
      "process.env": "{}",
      "process.env.NODE_ENV": '"test"',
      "process.env.NEXT_PUBLIC_SUPABASE_URL": '""',
      "process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": '""',
    },
  });
  bundle = result.outputFiles[0].text;
});
test("token refresh failure is safely announced while local documents/auth storage remain", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://video-browser.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ja"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Video client fixture</title><div id="root"></div></html>',
    }),
  );
  await page.goto("https://video-browser.test/");
  await page.evaluate(async () => {
    localStorage.setItem("axfluxo-auth", "existing-auth-storage");
    for (const name of [
      "axfluxo",
      "axfluxo-workflow",
      "axfluxo-workspace",
      "axfluxo-execution",
    ]) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("sentinel");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("sentinel", "readwrite");
        tx.objectStore("sentinel").put("existing-document", "data");
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    }
  });
  await page.addScriptTag({ content: bundle });
  expect(errors).toEqual([]);
  await page.evaluate(() =>
    (
      window as unknown as { runVideoFixture: (mode: string) => Promise<void> }
    ).runVideoFixture("expired"),
  );
  await expect(page.getByRole("alert")).toContainText(
    "ログインの期限が切れました",
  );
  await expect(page.getByRole("alert")).toContainText(
    "端末内の編集データは保持",
  );
  await expect(page.locator("body")).not.toContainText("secret");
  expect(await page.evaluate(() => localStorage.getItem("axfluxo-auth"))).toBe(
    "existing-auth-storage",
  );
  expect(
    await page.evaluate(async () => {
      const values = [];
      for (const name of [
        "axfluxo",
        "axfluxo-workflow",
        "axfluxo-workspace",
        "axfluxo-execution",
      ]) {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const r = indexedDB.open(name);
          r.onsuccess = () => resolve(r.result);
        });
        values.push(
          await new Promise<string>((resolve) => {
            const r = db
              .transaction("sentinel")
              .objectStore("sentinel")
              .get("data");
            r.onsuccess = () => resolve(r.result);
          }),
        );
        db.close();
      }
      return values;
    }),
  ).toEqual(Array(4).fill("existing-document"));
  for (const [mode, text, role] of [
    ["forbidden", "開発者権限", "alert"],
    ["held", "保留中", "status"],
    ["waiting", "待機中", "status"],
    ["failed", "処理に失敗", "alert"],
  ] as const) {
    await page.evaluate(
      (mode) =>
        (
          window as unknown as {
            runVideoFixture: (mode: string) => Promise<void>;
          }
        ).runVideoFixture(mode),
      mode,
    );
    await expect(page.getByRole(role)).toContainText(text);
    await expect(page.locator("body")).not.toContainText(
      "private backend detail",
    );
  }
  expect(errors).toEqual([]);
});
