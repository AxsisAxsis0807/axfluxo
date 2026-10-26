import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  openRunDB,
  runRepository,
} from "../src/services/workflow/run-repository";
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());
it("a newer execution database refuses the older client and preserves its stores/records", async () => {
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open("axfluxo-execution", 2);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("future").add("keep", "record");
    request.onsuccess = () => resolve(request.result);
  });
  db.close();
  await expect(openRunDB()).rejects.toMatchObject({ code: "DB_VERSION" });
  const reopened = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open("axfluxo-execution", 2);
    request.onsuccess = () => resolve(request.result);
  });
  const result = await new Promise((resolve) => {
    const r = reopened
      .transaction("future")
      .objectStore("future")
      .get("record");
    r.onsuccess = () => resolve(r.result);
  });
  reopened.close();
  expect(result).toBe("keep");
});
it("corrupt history is retained; cache eviction aborts instead of deleting unknown references", async () => {
  const db = await openRunDB(),
    corrupt = {
      id: crypto.randomUUID(),
      workflowId: "workflow",
      createdAt: new Date().toISOString(),
      state: "running",
      snapshot: { unknownVersion: true },
    };
  await new Promise<void>((resolve) => {
    const tx = db.transaction(["runs", "cache", "outputs"], "readwrite");
    tx.objectStore("runs").add(corrupt);
    tx.objectStore("cache").add({
      id: "keep-cache",
      unknownReference: "future-output",
    });
    tx.objectStore("outputs").add({ id: "future-output", unknown: "keep" });
    tx.oncomplete = () => resolve();
  });
  db.close();
  await expect(runRepository.list()).rejects.toThrow();
  await expect(runRepository.evictCache()).rejects.toThrow();
  const reopened = await openRunDB();
  const values = await Promise.all(
    ["runs", "cache", "outputs"].map(
      (store) =>
        new Promise<unknown[]>((resolve) => {
          const r = reopened.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => resolve(r.result);
        }),
    ),
  );
  reopened.close();
  expect(values[0]).toEqual([corrupt]);
  expect(values[1]).toHaveLength(1);
  expect(values[2]).toHaveLength(1);
});
