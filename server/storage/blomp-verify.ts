import { createHash, randomBytes } from "node:crypto";
import { blompConfiguration } from "./blomp-config";
import { BlompError, blompStorage, type BlompStorage } from "./blomp";

/** Explicit opt-in only. No service entrypoint, CI hook or import-time network activity. */
export async function verifyBlomp(
  env: Record<string, string | undefined>,
  args: string[],
  report: (step: string) => void,
  factory: typeof blompStorage = blompStorage,
) {
  if (
    args.length !== 2 ||
    !args.includes("--approved-connect") ||
    !args.includes("--approved-delete-test")
  )
    throw new BlompError("BLOMP_APPROVAL_REQUIRED");
  const config = blompConfiguration(env);
  if (!config) throw new BlompError("BLOMP_DISABLED");
  report("configuration: PASS");
  const storage = factory(config);
  try {
    await probe(storage, report);
  } finally {
    storage.close();
  }
}
async function probe(storage: BlompStorage, report: (step: string) => void) {
  const ref = storage.newTestReference();
  const bytes = randomBytes(1024);
  const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  try {
    // No bucket enumeration and no reads/writes to existing objects.
    await storage.putTest(ref, bytes);
    report("authenticated upload 1024 bytes: PASS");
    if ((await storage.head(ref))?.size !== bytes.length)
      throw new BlompError("BLOMP_SIZE_MISMATCH");
    report("HEAD: PASS");
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of await storage.stream(
      ref,
      undefined,
      AbortSignal.timeout(30000),
    )) {
      size += chunk.length;
      if (size > bytes.length) throw new BlompError("BLOMP_SIZE_MISMATCH");
      digest.update(chunk);
    }
    if (size !== bytes.length || digest.digest("hex") !== hash(bytes))
      throw new BlompError("BLOMP_HASH_MISMATCH");
    report("download SHA-256: PASS");
    const signed = await storage.sign(ref, "GET");
    const response = await fetch(signed.url, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok || !response.body)
      throw new BlompError("BLOMP_SIGNED_READ_FAILED");
    const reader = response.body.getReader(),
      signedHash = createHash("sha256");
    let received = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > bytes.length)
          throw new BlompError("BLOMP_SIZE_MISMATCH");
        signedHash.update(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (received !== bytes.length || signedHash.digest("hex") !== hash(bytes))
      throw new BlompError("BLOMP_HASH_MISMATCH");
    report("signed GET SHA-256 (server, not browser CORS): PASS");
  } catch (error) {
    report(
      "probe failed: " +
        (error instanceof BlompError
          ? error.code
          : "BLOMP_VERIFICATION_FAILED"),
    );
    throw error;
  } finally {
    // Also try cleanup after an ambiguous PUT response. Same invocation's random key only.
    try {
      await storage.deleteTest(ref);
      report("test object deletion: PASS");
      if (await storage.head(ref)) throw new BlompError("BLOMP_CLEANUP_FAILED");
      report("post-deletion HEAD absence: PASS");
    } catch {
      report("test cleanup: FAILED; owner must inspect connection-tests area");
      throw new BlompError("BLOMP_CLEANUP_FAILED");
    }
  }
}
