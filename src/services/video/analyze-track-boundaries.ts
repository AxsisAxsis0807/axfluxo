import { analyzeLocalWaveform } from "./local-waveform";
import {
  type BoundaryCandidate,
  type BoundarySettings,
} from "./track-boundaries";
export async function analyzeTrackBoundaries(
  file: File,
  duration: number,
  settings: BoundarySettings,
  signal: AbortSignal,
  progress: (value: number) => void,
) {
  const worker = new Worker(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/workers/track-boundary-v1.js`,
    { type: "module" },
  );
  let rejectPending: ((error: Error) => void) | undefined;
  const abort = () => {
    rejectPending?.(new DOMException("Aborted", "AbortError"));
    worker.terminate();
  };
  signal.addEventListener("abort", abort, { once: true });
  const send = <T>(message: unknown, transfer: Transferable[] = []) =>
    new Promise<T>((resolve, reject) => {
      signal.throwIfAborted();
      rejectPending = reject;
      worker.onmessage = (event) => {
        rejectPending = undefined;
        if (event.data.error) reject(Error(event.data.error));
        else resolve(event.data);
      };
      worker.onerror = () =>
        reject(
          Error(
            "解析Workerを開始できません。再読み込みして再試行してください。",
          ),
        );
      worker.postMessage(message, transfer);
    });
  try {
    await send({ type: "init", duration });
    const result = await analyzeLocalWaveform(
      file,
      duration,
      signal,
      (r) => progress(r.progress * 0.95),
      undefined,
      async (pcm, sampleRate, timestamp, from, until) => {
        const channels = pcm.map((c) => c.slice());
        await send(
          { type: "chunk", channels, sampleRate, timestamp, from, until },
          channels.map((c) => c.buffer),
        );
      },
    );
    if (result.status === "no-audio") throw Error("音声トラックがありません。");
    const complete = await send<{
      candidates: BoundaryCandidate[];
      levels: number[];
    }>({ type: "finish", settings });
    progress(1);
    return complete;
  } finally {
    signal.removeEventListener("abort", abort);
    worker.terminate();
  }
}
