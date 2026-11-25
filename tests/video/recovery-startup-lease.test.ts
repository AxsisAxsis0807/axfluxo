import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => vi.unstubAllGlobals());
async function setLease(until: number) {
  await new Promise<void>((resolve,reject) => {
    const req = indexedDB.open("axfluxo.local-video-recovery",1);
    req.onupgradeneeded = () => {
      for (const name of ["projects","assets","jobs","meta"]) req.result.createObjectStore(name);
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction("meta","readwrite");
      tx.objectStore("meta").put({owner:"previous-document",until},"lease");
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
it("waits for the previous document lease, then acquires it", async () => {
  await setLease(Date.now()+300);
  const s = await import("../../src/services/video/recovery-store");
  const waited = vi.fn();
  await s.acquireStartupRecoveryLease(new AbortController().signal, waited);
  expect(waited).toHaveBeenCalled();
  await expect(s.renewRecoveryLease()).resolves.toBeUndefined();
});
it("does not seize a live lease after cancellation", async () => {
  await setLease(Date.now()+60000);
  const s = await import("../../src/services/video/recovery-store");
  const control = new AbortController();
  await expect(s.acquireStartupRecoveryLease(control.signal,()=>control.abort())).rejects.toThrow();
  await expect(s.renewRecoveryLease()).rejects.toBeInstanceOf(s.RecoveryLeaseError);
});
it("does not let a previously fenced writer retake ownership", async () => {
  const s = await import("../../src/services/video/recovery-store");
  await s.renewRecoveryLease();
  await setLease(Date.now()-1);
  const waited = vi.fn();
  await expect(s.acquireStartupRecoveryLease(new AbortController().signal,waited)).rejects.toBeInstanceOf(s.RecoveryLeaseError);
  expect(waited).not.toHaveBeenCalled();
});
