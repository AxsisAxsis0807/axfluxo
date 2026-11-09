// Offline, explicit local-files cleanup only. Stop both parts first.
import { directory, uuid } from "./core.mjs";
import { rm, readdir, lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
const root = process.env.PROBE_ROOT,
  run = process.env.PROBE_RUN_ID;
if (
  process.argv[2] !== "--writers-stopped" ||
  !root ||
  !isAbsolute(root) ||
  root === "/" ||
  !uuid.test(run ?? "")
)
  throw Error(
    "Explicit probe root/run and stopped-writers acknowledgement required",
  );
const path = await directory(root, run);
for (const name of await readdir(path)) {
  if (
    !["api.json", "worker.json"].includes(name) ||
    !(await lstat(join(path, name))).isFile()
  )
    throw Error("Unexpected files: refusing cleanup");
}
await rm(path, { recursive: true });
console.log("Only this run's two probe marker files removed.");
