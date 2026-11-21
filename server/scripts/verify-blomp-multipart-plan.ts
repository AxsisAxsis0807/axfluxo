import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { blompConfiguration } from "../storage/blomp-config";
import { CompatibilityFailure } from "../storage/blomp-compatibility-transport";
import {
  blompMultipartPlans,
  probeBlompMultipart,
} from "../storage/blomp-multipart-probe";

async function main() {
  const [mode, scenario, ...extra] = process.argv.slice(2);
  if (extra.length || (scenario !== "B" && scenario !== "C"))
    throw new CompatibilityFailure("MULTIPART_APPROVAL_REQUIRED");
  const { key, requests } = blompMultipartPlans[scenario];
  if (mode === "--plan") {
    console.log(
      JSON.stringify({
        scenario,
        key,
        requests,
        uploadBytes: 9437184,
        downloadBytes: 9437184,
      }),
    );
    return;
  }
  if (mode !== "--approved-multipart-probe")
    throw new CompatibilityFailure("MULTIPART_APPROVAL_REQUIRED");
  const config = blompConfiguration(process.env);
  if (!config) throw new CompatibilityFailure("BLOMP_DISABLED");
  const directory = new URL(
    "../../work/blomp-multipart-runs/",
    import.meta.url,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record = new URL(scenario + ".jsonl", directory);
  await probeBlompMultipart({
    config,
    scenario,
    checkpoint(event) {
      const line = JSON.stringify(event) + "\n";
      if (event.stage === "reserved")
        writeFileSync(record, line, { flag: "wx", mode: 0o600, flush: true });
      else appendFileSync(record, line, { flush: true });
    },
    restoreCheckpoint() {
      const last = readFileSync(record, "utf8").trimEnd().split("\n").at(-1);
      if (!last)
        throw new CompatibilityFailure("MULTIPART_CHECKPOINT_MISMATCH");
      return JSON.parse(last);
    },
    report: console.log,
  });
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof CompatibilityFailure
      ? error.code
      : "MULTIPART_PROBE_STOPPED",
  );
  process.exitCode = 1;
});
