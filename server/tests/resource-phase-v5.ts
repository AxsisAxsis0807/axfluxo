// Offline v5 phase fixture only. No DB, storage, user media, or application entrypoint.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectFor, snapshotFor } from "../cloud-export/render";
import {
  backgroundImage,
  textImage,
} from "../worker/templates/all-versions/graphics";
import { mediaProcess } from "../worker/render/process";
const audit = process.env.RESOURCE_AUDIT_DIR;
if (audit !== "/work/result") throw Error("Isolated fixed path required");
const phase = process.argv[2];
const input = JSON.parse(await readFile("/work/phase-input.json", "utf8"));
const record = async (event: string) =>
  writeFile(
    join(audit, event + ".json"),
    JSON.stringify({
      t: performance.now(),
      memory: process.memoryUsage(),
      phase,
    }),
  );
await record("phase-begin");
if (phase === "background" || phase === "title") {
  const job = "00000000-0000-4000-8000-000000000001";
  const snapshot = snapshotFor(input.spec, job, [
    { blobId: "clip", hash: input.hash, durationUs: 15e6 },
  ]);
  const project = projectFor(input.spec, job, snapshot, {
    blobId: "cover",
    hash: input.coverHash,
  });
  const png =
    phase === "background"
      ? await backgroundImage(project, "/work/assets/synthetic.png")
      : (await textImage(project, 1)).png;
  await writeFile(join(audit, phase + ".png"), png);
} else {
  const args = input.argv;
  if (
    !Array.isArray(args) ||
    !["static-generate", "fade-encode", "static-encode", "mux"].includes(phase)
  )
    throw Error("Invalid offline phase");
  await mediaProcess("ffmpeg", args);
}
await record("phase-complete");
