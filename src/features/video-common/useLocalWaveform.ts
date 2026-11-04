"use client";
import { useEffect, useRef, useState } from "react";
import {
  analyzeLocalWaveform,
  type WaveformResult,
} from "../../services/video/local-waveform";

type State = Omit<WaveformResult, "status"> & {
  reason?: string;
  status: WaveformResult["status"] | "cancelled" | "paused" | "failed";
};
const cache = new WeakMap<File, WaveformResult>();
const initial: State = { status: "queued", progress: 0, analyzedUntilUs: 0 };

export function useLocalWaveform(file: File, duration: number) {
  const [entry, setEntry] = useState<{ file: File; state: State }>({
    file,
    state: initial,
  });
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    let finished = false;
    const abort = new AbortController();
    controller.current = abort;
    const set = (state: State) => {
      if (active) setEntry({ file, state });
    };
    const saved = cache.get(file);
    if (saved) set(saved);
    else {
      set(initial);
      void analyzeLocalWaveform(file, duration, abort.signal, set)
        .then((result) => {
          if (!active || abort.signal.aborted) return;
          finished = true;
          cache.set(file, result);
          set(result);
        })
        .catch((error: unknown) => {
          finished = true;
          if (active && !abort.signal.aborted)
            setEntry((old) => ({
              file,
              state: {
                ...old.state,
                status: "failed",
                reason:
                  error instanceof Error &&
                  /TOO_LARGE|TIMING_UNSUPPORTED/.test(error.message)
                    ? "安全な分割解析の上限または時間精度の条件を満たしません。"
                    : "この端末では音声形式を解析できないか、素材を読み取れません。",
              },
            }));
        });
    }
    const hidden = () => {
      if (
        document.visibilityState === "hidden" &&
        !finished &&
        !cache.has(file) &&
        !abort.signal.aborted
      ) {
        abort.abort();
        setEntry((old) => ({
          file,
          state: { ...old.state, status: "paused" },
        }));
      }
    };
    document.addEventListener("visibilitychange", hidden);
    hidden();
    return () => {
      active = false;
      abort.abort();
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [file, duration, attempt]);
  return {
    ...(entry.file === file ? entry.state : initial),
    cancel: () => {
      controller.current?.abort();
      setEntry((old) => ({
        file,
        state: { ...old.state, status: "cancelled" },
      }));
    },
    retry: () => setAttempt((value) => value + 1),
  };
}
