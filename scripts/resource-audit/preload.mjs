// Diagnostic preload only; never imported by the application.
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.env.RESOURCE_AUDIT_DIR;
if (!directory) throw Error("Isolated RESOURCE_AUDIT_DIR required");
const write = (row) =>
  appendFileSync(
    join(directory, "node.jsonl"),
    JSON.stringify({
      t: performance.now(),
      ...row,
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
    }) + "\n",
  );
const spawn = cp.spawn;
let id = 0;
cp.spawn = function (program, args, options) {
  if (
    program === "ffmpeg" &&
    process.argv.includes("audit-png-single-thread")
  ) {
    args = args.flatMap((arg, index) =>
      arg === "-i" && args[index + 1]?.endsWith(".png")
        ? ["-threads", "1", arg]
        : [arg],
    );
  }
  const child = spawn.call(this, program, args, options);
  if (["ffmpeg", "ffprobe"].includes(program)) {
    const number = ++id;
    // Fixed categories only; no filenames, filter text, environment or stderr.
    const phase =
      program === "ffprobe"
        ? "probe"
        : args.includes("libx264")
          ? "encode"
          : args.includes("-f") && args.includes("null")
            ? "decode-validation"
            : "mux-or-image";
    write({ event: "spawn", program, id: number, pid: child.pid, phase });
    child.once("close", (code, signal) =>
      write({ event: "close", id: number, code, signal }),
    );
  }
  return child;
};
syncBuiltinESMExports();
write({ event: "startup" });
const timer = setInterval(() => write({ event: "memory" }), 25);
timer.unref();
process.once("exit", (code) => write({ event: "exit", code }));
