import { IDBDatabase, IDBFactory } from "fake-indexeddb";
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

it("coalesces concurrent lease renewals into one meta-only transaction", async () => {
  const s = await import("../../src/services/video/recovery-store");
  const spy = vi.spyOn(IDBDatabase.prototype, "transaction");
  try {
    const first = s.renewRecoveryLease();
    const pending = Array.from({ length: 10 }, () => s.renewRecoveryLease());
    expect(pending.every((promise) => promise === first)).toBe(true);
    await Promise.all([first, ...pending]);
    // fake-indexeddb exposes the initial schema upgrade through the same spy.
    // Exclude only versionchange; any unexpected readonly or readwrite call
    // must still fail the exact transaction-count and scope assertions.
    const leaseTransactions = () =>
      spy.mock.calls.filter(([, mode]) => mode !== "versionchange");
    const upgrades = () =>
      spy.mock.calls.filter(([, mode]) => mode === "versionchange");
    expect(upgrades()).toHaveLength(1);
    expect(leaseTransactions()).toEqual([[["meta"], "readwrite"]]);
    await s.renewRecoveryLease();
    expect(upgrades()).toHaveLength(1);
    expect(leaseTransactions()).toEqual([
      [["meta"], "readwrite"],
      [["meta"], "readwrite"],
    ]);
  } finally {
    spy.mockRestore();
  }
});

it("does not leave a rejected renewal cached or bypass the ownership fence", async () => {
  const s = await import("../../src/services/video/recovery-store");
  await setLease(Date.now() + 60_000);
  const first = s.renewRecoveryLease();
  expect(s.renewRecoveryLease()).toBe(first);
  await expect(first).rejects.toBeInstanceOf(s.RecoveryLeaseError);
  await setLease(Date.now() - 1);
  await expect(s.renewRecoveryLease()).resolves.toBeUndefined();
  await setLease(Date.now() - 1);
  await expect(s.renewRecoveryLease()).rejects.toBeInstanceOf(s.RecoveryLeaseError);
});
