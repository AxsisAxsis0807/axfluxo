import { spawn, type SpawnOptions } from "node:child_process";
/** Abort sends TERM, then KILL. Callers settle on close, after pipes and process are gone. */
export function spawnMedia(
  program: string,
  args: string[],
  options: SpawnOptions & { signal?: AbortSignal },
) {
  const { signal, ...rest } = options;
  const child = spawn(program, args, rest);
  let forced: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    if (forced) return;
    child.kill("SIGTERM");
    forced = setTimeout(() => child.kill("SIGKILL"), 2000);
  };
  const deadline = setTimeout(abort, 86400000);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  child.once("close", () => {
    clearTimeout(deadline);
    clearTimeout(forced);
    signal?.removeEventListener("abort", abort);
  });
  return child;
}
