import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCompatibilityGate,
  verifyBlompCompatibility,
} from "../storage/blomp-compatibility";
import { CompatibilityFailure } from "../storage/blomp-compatibility-transport";

function readEvidence(path?: string) {
  if (!path) return undefined;
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0)
      throw new CompatibilityFailure("UNSAFE_EVIDENCE_FILE");
    const bytes = Buffer.alloc(4097);
    const size = readSync(descriptor, bytes);
    if (size > 4096) throw new CompatibilityFailure("UNSAFE_EVIDENCE_FILE");
    return JSON.parse(bytes.subarray(0, size).toString("utf8")) as unknown;
  } finally {
    closeSync(descriptor);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const evidence = readEvidence(process.env.BLOMP_PHASE3_EVIDENCE_FILE);
  checkCompatibilityGate(process.env, args, evidence);
  const directory = mkdtempSync(join(tmpdir(), "axfluxo-blomp-compatibility-"));
  const path = join(directory, "journal.jsonl");
  const descriptor = openSync(path, "wx", 0o600);
  process.stdout.write("Private journal: " + path + "\n");
  try {
    const journal = (event: Record<string, unknown>) => {
      const line = Buffer.from(JSON.stringify(event) + "\n");
      if (writeSync(descriptor, line) !== line.length)
        throw new CompatibilityFailure("JOURNAL_WRITE_FAILED");
      fsyncSync(descriptor);
    };
    const result = await verifyBlompCompatibility({
      env: process.env,
      args,
      evidence,
      journal,
      checkpoint(value) {
        const file = join(directory, "multipart-checkpoint.json");
        const handle = openSync(file, "wx+", 0o600);
        try {
          const bytes = Buffer.from(JSON.stringify(value));
          if (writeSync(handle, bytes) !== bytes.length)
            throw new CompatibilityFailure("CHECKPOINT_WRITE_FAILED");
          fsyncSync(handle);
          const restored = Buffer.alloc(bytes.length);
          if (
            readSync(handle, restored, 0, restored.length, 0) !==
            restored.length
          )
            throw new CompatibilityFailure("CHECKPOINT_READ_FAILED");
          return JSON.parse(restored.toString("utf8")) as unknown;
        } finally {
          closeSync(handle);
        }
      },
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (
      result.residualPossible ||
      Object.values(result.outcomes).includes("FAIL")
    )
      process.exitCode = 1;
  } finally {
    closeSync(descriptor);
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof CompatibilityFailure
      ? error.code
      : "COMPATIBILITY_PROBE_FAILED") + "\n",
  );
  process.exitCode = 1;
});
