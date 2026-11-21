import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blompConfiguration } from "../storage/blomp-config";
import { CompatibilityFailure } from "../storage/blomp-compatibility-transport";
import {
  blompFolderTestBytes,
  verifyBlompFolders,
} from "../storage/blomp-folder-verify";
import { blompTestFolderKeys } from "../storage/blomp-keys";

async function main() {
  const [mode, runId, ...extra] = process.argv.slice(2);
  if (
    !runId ||
    extra.length ||
    !["--plan", "--approved-create-test-objects"].includes(mode)
  )
    throw new CompatibilityFailure("FOLDER_APPROVAL_REQUIRED");
  const keys = blompTestFolderKeys(runId);
  if (mode === "--plan") {
    console.log(JSON.stringify({ keys, bytesPerObject: blompFolderTestBytes }));
    return;
  }
  const config = blompConfiguration(process.env);
  if (!config) throw new CompatibilityFailure("BLOMP_DISABLED");
  const directory = new URL("../../work/blomp-folder-runs/", import.meta.url);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  await verifyBlompFolders(
    config,
    runId,
    (targets) => {
      // Exclusive reservation persists even if an operation times out or the process exits.
      writeFileSync(
        new URL(join(runId + ".json"), directory),
        JSON.stringify(targets),
        { flag: "wx", mode: 0o600, flush: true },
      );
    },
    console.log,
  );
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof CompatibilityFailure ? error.code : "FOLDER_RUN_STOPPED",
  );
  process.exitCode = 1;
});
