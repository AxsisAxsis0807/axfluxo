// Offline recovery only. Never imported by application or performance cases.
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
const point = process.argv.at(-1)?.replace("audit-stop-", "");
const allowed = ["png-generating", "png-complete", "encode-start", "segment-complete", "before-next-segment", "fade-running", "before-mux"];
if (!allowed.includes(point)) throw Error("Invalid offline stop point");
const freeze = (event, pid) => {
  if (pid) process.kill(pid, "SIGSTOP");
  writeFileSync(process.env.RESOURCE_AUDIT_DIR + "/stop-marker.json", JSON.stringify({point, event, nodePid: process.pid, mediaPid: pid ?? null}));
  process.kill(process.pid, "SIGSTOP");
};
const spawn = cp.spawn;
cp.spawn = function(program, args, options) {
  const output = args.at(-1)?.split("/").pop();
  const generation = /^(av|reference)-static-\d+\.png$/.test(output ?? "");
  const use = args.some((a, i) => a === "-i" && /\/(av|reference)-static-\d+\.png$/.test(args[i+1] ?? ""));
  if (program === "ffmpeg" && use && output === "segment-2.mp4" && point === "before-next-segment") freeze("before-next-spawn");
  if (program === "ffmpeg" && output === "candidate.mp4" && point === "before-mux") freeze("before-concat-mux-spawn");
  const child = spawn.call(this, program, args, options);
  if (program === "ffmpeg") {
    if (output === "segment-0.mp4" && point === "fade-running") {
      // Child has run for 100ms before being frozen; not a precise frame boundary.
      setTimeout(() => freeze("fade-process-running-100ms", child.pid), 100);
    }
    if (generation && point === "png-generating") freeze("png-process-spawned", child.pid);
    if (use && point === "encode-start") freeze("static-encode-spawned", child.pid);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal) return;
      if (generation && point === "png-complete") freeze("png-process-successfully-closed");
      if (use && point === "segment-complete") freeze("static-segment-successfully-closed");
    });
  }
  return child;
};
syncBuiltinESMExports();
