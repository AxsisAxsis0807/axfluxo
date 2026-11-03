// A device-local convenience lock, never a cloud authorization credential.
export const LOCK_KEY = "axfluxo.developer.local-lock.v1";
export const SESSION_KEY = "axfluxo.developer.local-unlock.v1";
export const UNLOCK_MS = 2 * 60 * 60 * 1000;
type Verifier = { salt: string; hash: string };
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export async function derive(passcode: string, salt: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: new TextEncoder().encode(salt),
          iterations: 210000,
        },
        key,
        256,
      ),
    ),
  );
}
export function readVerifier(storage: Storage): Verifier | null {
  const raw = storage.getItem(LOCK_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (!/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{64}$/.test(value.hash))
    throw Error(
      "ロック設定が壊れています。このサイトのロック設定だけを削除して再設定してください。",
    );
  return value;
}
export async function configureLock(passcode: string, storage: Storage) {
  if (passcode.length < 8)
    throw Error("8文字以上のパスコードを設定してください。");
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  storage.setItem(
    LOCK_KEY,
    JSON.stringify({ salt, hash: await derive(passcode, salt) }),
  );
}
export async function verifyLock(passcode: string, storage: Storage) {
  const verifier = readVerifier(storage);
  return Boolean(
    verifier && (await derive(passcode, verifier.salt)) === verifier.hash,
  );
}
export function isUnlocked(storage: Storage, now = Date.now()) {
  const until = Number(storage.getItem(SESSION_KEY));
  return Number.isFinite(until) && until > now && until <= now + UNLOCK_MS;
}
