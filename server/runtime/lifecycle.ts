import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { integerSetting, type Environment } from "./config";
export function isEntrypoint(url: string, names: string[]) {
  const entry = process.argv[1];
  return Boolean(
    entry &&
    names.some((name) => entry.endsWith(name)) &&
    pathToFileURL(resolve(entry)).href === url,
  );
}
/** A finite last resort for stuck native I/O/pool shutdown. Never used on import. */
export async function runService(
  start: (signal: AbortSignal) => Promise<() => Promise<void>>,
  env: Environment,
) {
  const stop = new AbortController();
  const grace = integerSetting(env, "VIDEO_SHUTDOWN_MS", 20000, 3000, 120000);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const shutdown = () => {
    if (stop.signal.aborted) return;
    stop.abort();
    deadline = setTimeout(() => process.exit(1), grace);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    const close = await start(stop.signal);
    if (!stop.signal.aborted)
      await new Promise<void>((resolve) =>
        stop.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    await close();
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  }
}
