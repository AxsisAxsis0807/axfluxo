import { verifyBlomp } from "../storage/blomp-verify";
import { BlompError } from "../storage/blomp";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

void verifyBlomp(
  process.env,
  process.argv.slice(2),
  (step) => process.stdout.write(step + "\n"),
  undefined,
  (key) => {
    try {
      const path = join(
        mkdtempSync(join(tmpdir(), "axfluxo-blomp-probe-")),
        "key.txt",
      );
      writeFileSync(path, key + "\n", { mode: 0o600, flag: "wx", flush: true });
      process.stdout.write(`Private test-key record: ${path}\n`);
    } catch {
      throw new BlompError("BLOMP_KEY_RECORD_FAILED");
    }
  },
).catch((error: unknown) => {
  // Never print raw SDK/fetch errors, causes, config, tokens, keys or signed URLs.
  process.stderr.write(
    (error instanceof BlompError ? error.code : "BLOMP_VERIFICATION_FAILED") +
      "\n",
  );
  process.exitCode = 1;
});
