import { jobs, saveJob, write, type LocalJob } from "./storage";
import type { EncodingEngine } from "./engine";
import { WORK_MS, REST_MS } from "./plan";
export function waitUntil(
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      Math.max(0, deadline - Date.now()),
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
/** Caller holds a browser-wide Web Lock. Checkpoint is committed before its cursor. */
export async function runQueue(
  owner: string,
  engine: EncodingEngine,
  signal: AbortSignal,
  changed: () => void,
  now = () => performance.now(),
  wait = waitUntil,
) {
  let current: LocalJob | undefined;
  try {
    while (!signal.aborted) {
      current = (await jobs(owner)).find(
        (j) => !["cancelled", "completed", "failed"].includes(j.state),
      );
      if (!current) return;
      if (current.restUntil > Date.now()) {
        current.state = "resting";
        await saveJob(current);
        changed();
        engine.dispose();
        await wait(current.restUntil, signal);
        current.activeMs = 0;
        current.restUntil = 0;
      } else if (current.restUntil) {
        current.activeMs = 0;
        current.restUntil = 0;
      }
      current.state = "running";
      await saveJob(current);
      changed();
      while (current.next < current.total) {
        signal.throwIfAborted();
        const started = now();
        const part = await engine.chunk(current, signal);
        signal.throwIfAborted();
        await write(owner, `part:${current.id}:${current.next}`, part);
        current.next++;
        current.activeMs += Math.max(0, now() - started);
        if (current.activeMs >= WORK_MS) {
          current.restUntil = Date.now() + REST_MS;
          current.state = "resting";
        }
        await saveJob(current);
        changed();
        if (current.restUntil) break;
      }
      if (current.restUntil) continue;
      signal.throwIfAborted();
      const started = now(),
        output = await engine.finish(current, signal);
      signal.throwIfAborted();
      await write(owner, `output:${current.id}`, output);
      current.activeMs += Math.max(0, now() - started);
      current.state = "completed";
      await saveJob(current);
      changed();
      const next = (await jobs(owner)).find(
        (j) => !["cancelled", "completed", "failed"].includes(j.state),
      );
      if (next) {
        next.activeMs = current.activeMs;
        if (next.activeMs >= WORK_MS) {
          next.restUntil = Date.now() + REST_MS;
          next.state = "resting";
        }
        await saveJob(next);
      }
      engine.dispose();
    }
  } catch (e) {
    if (current) {
      current.state = signal.aborted ? "paused" : "failed";
      current.error = signal.aborted
        ? undefined
        : e instanceof Error
          ? e.message
          : "処理に失敗しました。";
      await saveJob(current);
      changed();
    }
    if (!signal.aborted) throw e;
  } finally {
    engine.dispose();
  }
}
