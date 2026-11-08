import { isEntrypoint, runService } from "../../runtime/lifecycle";
import { integerSetting } from "../../runtime/config";
import { runWorker } from "./service";
import { workerTasks, type WorkerKind } from "./tasks";
export async function startWorker(only?: WorkerKind) {
  if (process.getuid?.() === 0) throw Error("Non-root worker required");
  const pollMs = integerSetting(
    process.env,
    "VIDEO_WORKER_POLL_MS",
    1000,
    100,
    60000,
  );
  await runService(async (signal) => {
    const runtime = await workerTasks(process.env, only);
    const loop = runWorker(runtime.tasks, signal, {
      pollMs,
      onError: () =>
        process.stderr.write("Worker unit failed; bounded retry scheduled.\n"),
    });
    return async () => {
      try {
        await loop;
      } finally {
        await runtime.close();
      }
    };
  }, process.env);
}
export function launchWorker(kind?: WorkerKind) {
  void startWorker(kind).catch(() => {
    process.stderr.write(
      "Worker startup/operation failed. Verify server configuration.\n",
    );
    process.exitCode = 1;
  });
}
if (isEntrypoint(import.meta.url, ["worker.mjs", "runtime/main.ts"]))
  launchWorker();
