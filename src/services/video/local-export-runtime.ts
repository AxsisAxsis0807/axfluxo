import { ExportQueue } from "./export-queue";
import { encodeLocal } from "./local-encode";
import { isUnlocked } from "../developer/local-lock";
let audio: AudioContext | undefined;
const budget = { processing: 0 };
/** Call synchronously from a tap to unlock Web Audio on Safari. */
export function allowExportAudio(): Promise<void> {
  try {
    if (typeof AudioContext === "undefined")
      return Promise.reject(
        Error("このブラウザーは音声処理に対応していません。"),
      );
    audio ??= new AudioContext();
    return audio.resume();
  } catch (error) {
    return Promise.reject(error);
  }
}
export const localExportQueue = new ExportQueue(
  async (job, signal, rest, update) => {
    if (!isUnlocked(sessionStorage)) {
      localExportQueue.pause();
      throw Error("簡易ロックを解除して再試行してください。");
    }
    await flushExportRecovery();
    signal.throwIfAborted();
    const urls: string[] = [];
    try {
      audio ??= new AudioContext();
      if (audio.state !== "running") {
        update(0, "音声処理を許可してください");
        // Automatic processing continues once the explicit Safari activation is given.
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            audio?.removeEventListener("statechange", check);
            signal.removeEventListener("abort", abort);
          };
          const check = () => {
            if (audio?.state === "running") {
              cleanup();
              resolve();
            }
          };
          const abort = () => {
            cleanup();
            reject(signal.reason);
          };
          audio!.addEventListener("statechange", check);
          signal.addEventListener("abort", abort, { once: true });
          check();
        });
      }
      signal.throwIfAborted();
      if (persistenceEnabled) await renewRecoveryLease();
      const owned = {
        ...job,
        pieces: job.pieces.map((p) => {
          if (!p.file) return p;
          const url = URL.createObjectURL(p.file);
          urls.push(url);
          return { ...p, url: async () => url };
        }),
      };
      let message = "端末内で処理中",
        progress = 0,
        lastUpdate = 0;
      const result = await encodeLocal(
        owned,
        audio,
        signal,
        rest,
        budget,
        (value) => {
          const changed = message !== value;
          message = value;
          const now = performance.now();
          if (changed || now - lastUpdate >= 100) {
            lastUpdate = now;
            update(progress, message);
          }
        },
        (value) => {
          progress = value;
        },
      );
      if (persistenceEnabled) await renewRecoveryLease();
      signal.throwIfAborted();
      return result;
    } finally {
      urls.forEach(URL.revokeObjectURL);
    }
  },
  12,
  512 * 1024 * 1024,
  256 * 1024 * 1024,
);
// Release idle audio only after the slot's cleanup and the whole drain finish.
export function releaseIdleExportAudio() {
  queueMicrotask(() => {
    const state = localExportQueue.getSnapshot();
    if (
      !localExportQueue.isRunning() &&
      (state.paused ||
        !state.entries.some((e) =>
          ["queued", "preparing", "rendering"].includes(e.state),
        )) &&
      audio
    ) {
      const idle = audio;
      audio = undefined;
      void idle.close().catch(() => {});
    }
  });
}
localExportQueue.subscribe(releaseIdleExportAudio);

// Start only from a mounted, unlocked tool. Hydration must finish before admission.
let initialized: Promise<void> | undefined;
let persistenceTail = Promise.resolve();
let persistenceEnabled = false;
let recoveryFailure = "";
const recoveryListeners = new Set<() => void>();
export const subscribeRecovery = (listener: () => void) => {
  recoveryListeners.add(listener);
  return () => {
    recoveryListeners.delete(listener);
  };
};
export const getRecoveryError = () => recoveryFailure;
function reportRecoveryFailure(error: unknown) {
  recoveryFailure = recoveryMessage(error);
  recoveryListeners.forEach((listener) => listener());
}
export function flushExportRecovery() {
  return persistenceTail;
}
export function initializeExportRecovery() {
  return (initialized ??= (async () => {
    localExportQueue.pause();
    const entries = await loadExportEntries();
    localExportQueue.restore(entries);
    persistenceEnabled = true;
    localExportQueue.resume();
  })().catch((error) => {
    initialized = undefined;
    reportRecoveryFailure(error);
    throw error;
  }));
}
localExportQueue.subscribe(() => {
  if (!persistenceEnabled) return;
  const entries = localExportQueue.getSnapshot().entries;
  persistenceTail = persistenceTail
    .catch(() => {})
    .then(() => saveExportEntries(entries));
  void persistenceTail.catch((error) => {
    // Do not recursively publish more failed writes.
    persistenceEnabled = false;
    reportRecoveryFailure(error);
    localExportQueue.pause(true);
  });
});
import {
  loadExportEntries,
  saveExportEntries,
  recoveryMessage,
  renewRecoveryLease,
} from "./recovery-store";

export async function retryRecoveryPersistence() {
  if (!recoveryFailure) return;
  await persistenceTail.catch(() => {});
  await renewRecoveryLease();
  await saveExportEntries(localExportQueue.getSnapshot().entries);
  persistenceTail = Promise.resolve();
  persistenceEnabled = true;
  recoveryFailure = "";
  recoveryListeners.forEach((listener) => listener());
}
