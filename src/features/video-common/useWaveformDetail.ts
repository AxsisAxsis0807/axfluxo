"use client";
import { useEffect, useState } from "react";
import type { Waveform } from "../../domain/video/preview";
import { analyzeLocalWaveform } from "../../services/video/local-waveform";
export type VisibleWindow = { start: number; end: number; pps: number };
const cache = new WeakMap<File, Map<string, Waveform>>();
/** Only the visible source interval is decoded; stale generations are never published. */
export function useWaveformDetail(
  file: File,
  duration: number,
  view: VisibleWindow | undefined,
  ready: boolean,
): { waveform?: Waveform; status: string } {
  const start = view ? Math.max(0, Math.floor(view.start * 4) / 4) : 0;
  const end = view ? Math.min(duration, Math.ceil(view.end * 4) / 4) : 0;
  const step = view
    ? Math.max(1 / 48000, 1 / (2 ** Math.ceil(Math.log2(view.pps)) * 2))
    : 1;
  const enabled =
    ready && !!view && view.pps > 100 && end > start && end - start <= 30;
  const key = `${start}:${end}:${step}`;
  const [entry, setEntry] = useState<{
    file: File;
    key: string;
    waveform?: Waveform;
    status: string;
  }>();
  useEffect(() => {
    if (!enabled) return;
    const control = new AbortController();
    const saved = cache.get(file)?.get(key);
    if (saved) {
      setEntry({ file, key, waveform: saved, status: "高精細波形" });
      return;
    }
    setEntry({ file, key, status: "高精細波形を準備中（概要を表示）" });
    const hidden = () => {
      if (document.hidden) control.abort();
    };
    document.addEventListener("visibilitychange", hidden);
    const timer = setTimeout(() => {
      void analyzeLocalWaveform(file, duration, control.signal, () => {}, {
        start,
        end,
        step,
      })
        .then((result) => {
          if (control.signal.aborted || !result.waveform) return;
          const entries = cache.get(file) ?? new Map<string, Waveform>();
          entries.set(key, result.waveform);
          while (entries.size > 4) entries.delete(entries.keys().next().value!);
          cache.set(file, entries);
          setEntry({
            file,
            key,
            waveform: result.waveform,
            status: "高精細波形",
          });
        })
        .catch(() => {
          if (!control.signal.aborted)
            setEntry({
              file,
              key,
              status: "高精細解析を利用できません（概要を表示）",
            });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      control.abort();
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [file, duration, enabled, start, end, step, key]);
  return enabled && entry?.file === file && entry.key === key
    ? entry
    : { status: enabled ? "高精細波形を準備中（概要を表示）" : "概要波形" };
}
