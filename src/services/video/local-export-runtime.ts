import { ExportQueue, type ExportEntry } from "./export-queue";
import { encodeLocal, usesTimedLocalEncoding, type LocalEncodeJob } from "./local-encode";
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
      const legacyRecorder = !usesTimedLocalEncoding(job);
      if (legacyRecorder) audio ??= new AudioContext();
      if (legacyRecorder && audio?.state !== "running") {
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

// The queue owns storage initialization and the lease independently of editor mounts.
let initialized: Promise<void> | undefined;
let restored = false;
let persistenceTail = Promise.resolve();
let persistenceEnabled = false;
let lastPublishedEntries: ExportEntry[] = [];
let recoveryFailure = "";
const recoveryListeners = new Set<() => void>();
export const subscribeRecovery = (listener: () => void) => {
  recoveryListeners.add(listener);
  return () => {
    recoveryListeners.delete(listener);
  };
};
export const getRecoveryError = () => recoveryFailure;
function setRecoveryError(message: string) {
  recoveryFailure = message;
  recoveryListeners.forEach((listener) => listener());
}
function stopPersistence(error: unknown) {
  if (!persistenceEnabled) return;
  persistenceEnabled = false;
  setRecoveryError(recoveryMessage(error));
  localExportQueue.pause(true);
}
export function flushExportRecovery() {
  return persistenceTail;
}

function initializeExportRecovery() {
  return (initialized ??= (async () => {
    const controller = new AbortController();
    const { signal } = controller;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = Error("書き出しデータの復旧が応答していません。保存済みデータは削除していません。");
        controller.abort(error);
        reject(error);
      }, 90_000);
      void (async () => {
        await acquireStartupRecoveryLease(signal, () => {});
        const entries = await loadExportEntries();
        signal.throwIfAborted();
        const wasPaused = localExportQueue.getSnapshot().paused;
        localExportQueue.restore(entries);
        // Restoring existing rows is a read of the queue. A pause/resume that
        // leaves all rows intact does not need an IDB write or asset collection.
        lastPublishedEntries = [...entries];
        restored = true;
        persistenceEnabled = true;
        setRecoveryError("");
        if (!wasPaused) localExportQueue.resume();
      })().then(resolve, reject).finally(() => clearTimeout(timer));
    });
  })().catch((error) => {
    initialized = undefined;
    setRecoveryError(recoveryMessage(error));
    throw error;
  }));
}

export async function discoverExportRecovery(signal: AbortSignal) {
  try {
    if (initialized) {
      await initialized;
      return;
    }
    const count = await countStoredExportEntries();
    signal.throwIfAborted();
    if (count) await initializeExportRecovery();
    else if (!initialized) setRecoveryError("");
  } catch (error) {
    if (!signal.aborted && !restored) setRecoveryError(recoveryMessage(error));
  }
}

export async function reserveLocalExports(jobs: LocalEncodeJob[], rest: boolean) {
  try {
    await initializeExportRecovery();
    if (!persistenceEnabled) throw Error(recoveryFailure);
    localExportQueue.enqueue(jobs, rest);
    // The runner also waits for persistence before it opens a decoder.
    await flushExportRecovery();
  } catch (error) {
    if (recoveryFailure) throw Error(recoveryFailure, { cause: error });
    throw error;
  }
}

localExportQueue.subscribe(() => {
  if (!persistenceEnabled) return;
  const { entries } = localExportQueue.getSnapshot();
  if (
    entries.length === lastPublishedEntries.length &&
    entries.every((entry, index) => entry === lastPublishedEntries[index])
  ) return;
  lastPublishedEntries = entries;
  const save = persistenceTail.then(() => saveExportEntries(entries));
  persistenceTail = save;
  void save.catch(stopPersistence);
});

let heartbeat: ReturnType<typeof setTimeout> | undefined;
let renewing = false;
let pageHidden = false;
function scheduleHeartbeat() {
  if (
    pageHidden || renewing || heartbeat !== undefined ||
    !persistenceEnabled || !localExportQueue.isRunning()
  ) return;
  heartbeat = setTimeout(() => {
    heartbeat = undefined;
    if (!persistenceEnabled || !localExportQueue.isRunning()) return;
    renewing = true;
    void renewRecoveryLease().catch(stopPersistence).finally(() => {
      renewing = false;
      scheduleHeartbeat();
    });
  }, 5000);
}
localExportQueue.subscribe(scheduleHeartbeat);
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    pageHidden = true;
    clearTimeout(heartbeat);
    heartbeat = undefined;
  });
  window.addEventListener("pageshow", () => {
    pageHidden = false;
    scheduleHeartbeat();
  });
}
import {
  acquireStartupRecoveryLease,
  countStoredExportEntries,
  loadExportEntries,
  saveExportEntries,
  recoveryMessage,
  renewRecoveryLease,
} from "./recovery-store";

let retrying: Promise<void> | undefined;
export function retryRecoveryPersistence() {
  if (!restored) return initializeExportRecovery();
  if (!recoveryFailure) return Promise.resolve();
  return (retrying ??= (async () => {
    await persistenceTail.catch(() => {});
    await renewRecoveryLease();
    const before = localExportQueue.getSnapshot();
    await saveExportEntries(before.entries);
    persistenceTail = Promise.resolve();
    lastPublishedEntries = before.entries;
    persistenceEnabled = true;
    setRecoveryError("");
    // Replay any queue changes made while the retry was writing its snapshot.
    const current = localExportQueue.getSnapshot();
    if (before !== current) {
      lastPublishedEntries = current.entries;
      persistenceTail = saveExportEntries(current.entries);
      void persistenceTail.catch(stopPersistence);
      await persistenceTail;
    }
  })().finally(() => { retrying = undefined; }));
}
