import { setTimeout as delay } from "node:timers/promises";
export type WorkerTask = {
  name: string;
  enabled: () => boolean;
  run: (signal: AbortSignal) => Promise<unknown>;
};
/** One awaited unit per stage and pass: no competing media loops or starvation by a busy queue. */
export async function runWorker(
  tasks: WorkerTask[],
  signal: AbortSignal,
  options: {
    pollMs?: number;
    backoffMs?: number;
    maxBackoffMs?: number;
    now?: () => number;
    pause?: (ms: number, signal: AbortSignal) => Promise<void>;
    onError?: (name: string) => void;
  } = {},
) {
  const poll = options.pollMs ?? 1000,
    base = options.backoffMs ?? 5000,
    max = options.maxBackoffMs ?? 60000;
  if (
    ![poll, base, max].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= 60000,
    ) ||
    base > max
  )
    throw Error("Invalid worker scheduling configuration");
  const now = options.now ?? Date.now;
  const pause =
    options.pause ??
    (async (ms, signal) => {
      await delay(ms, undefined, { signal }).catch(() => undefined);
    });
  const failures = new Map<WorkerTask, { count: number; next: number }>();
  while (!signal.aborted) {
    for (const task of tasks) {
      if (signal.aborted) break;
      if (!task.enabled() || (failures.get(task)?.next ?? 0) > now()) continue;
      try {
        await task.run(signal);
        failures.delete(task);
      } catch {
        if (signal.aborted) break;
        const count = Math.min((failures.get(task)?.count ?? 0) + 1, 10);
        failures.set(task, {
          count,
          next: now() + Math.min(max, base * 2 ** (count - 1)),
        });
        options.onError?.(task.name);
      }
    }
    if (!signal.aborted) await pause(poll, signal);
  }
}
