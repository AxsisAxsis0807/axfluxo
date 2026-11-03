import { describe, expect, it } from "vitest";
import {
  configureLock,
  verifyLock,
  isUnlocked,
  LOCK_KEY,
  SESSION_KEY,
  UNLOCK_MS,
} from "../src/services/developer/local-lock";
function memory() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, v),
    removeItem: (k: string) => map.delete(k),
  } as Storage;
}
describe("device convenience lock", () => {
  it("stores only a salted verifier and rejects wrong input", async () => {
    const storage = memory();
    await configureLock("test-only-passcode", storage);
    expect(storage.getItem(LOCK_KEY)).not.toContain("test-only-passcode");
    expect(await verifyLock("wrong", storage)).toBe(false);
    expect(await verifyLock("test-only-passcode", storage)).toBe(true);
  });
  it("fails closed for missing, expired and malformed sessions", () => {
    const storage = memory(),
      now = Date.now();
    expect(isUnlocked(storage, now)).toBe(false);
    for (const value of [
      "NaN",
      "Infinity",
      String(now - 1),
      String(now + UNLOCK_MS + 1),
    ]) {
      storage.setItem(SESSION_KEY, value);
      expect(isUnlocked(storage, now)).toBe(false);
    }
    storage.setItem(SESSION_KEY, String(now + 1000));
    expect(isUnlocked(storage, now)).toBe(true);
    storage.removeItem(SESSION_KEY);
    expect(isUnlocked(storage, now)).toBe(false);
  });
});
