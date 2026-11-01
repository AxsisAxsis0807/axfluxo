"use client";
import { loadWaveform } from "../../services/video/waveform";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  allVersionsDocumentSchema,
  type AllVersionsDocument,
} from "../../domain/video/schema";
import { type PreviewInfo, type Waveform } from "../../domain/video/preview";
import {
  mediaVersionRefSchema,
  type MediaVersionRef,
} from "../../domain/cloud-library/schema";
import {
  clipAt,
  formatTime,
  frameTimeUs,
  moveRange,
  stepTime,
  validateRange,
  type PreviewRange,
} from "../../services/video/time";
import {
  PlaybackController,
  PlaybackError,
  type PreviewError,
} from "../../services/video/playback";
import { Timeline, type TimelineItem } from "./Timeline";
import { TimeField } from "./TimeField";
export type PreviewResolver = (ref: MediaVersionRef) => Promise<PreviewInfo>;
export const previewMessages: Record<PreviewError, string> = {
  PROXY_NOT_READY: "proxyはまだ準備できていません。後で再確認してください。",
  SOURCE_MISSING: "元素材または固定versionが見つかりません。",
  PLAYBACK_FAILED: "再生できませんでした。再生ボタンをもう一度押してください。",
  AUTH_EXPIRED: "認証の期限が切れました。再ログイン後に再確認してください。",
  INVALID_INTERVAL: "時刻または区間が無効です。元素材は変更されていません。",
  PREVIEW_FAILED: "preview生成に失敗しました。元素材は保持されています。",
};
export function VideoPreview({
  mode,
  document,
  onDocumentChange,
  resolve,
  overlay,
  onTimeChange,
}: {
  mode: "all-versions" | "fnf";
  document: AllVersionsDocument;
  onDocumentChange: (document: AllVersionsDocument) => void;
  resolve: PreviewResolver;
  overlay?: import("react").ReactNode;
  onTimeChange?: (us: number) => void;
}) {
  const video = useRef<HTMLVideoElement>(null),
    controller = useRef<PlaybackController | null>(null),
    timeRef = useRef(0),
    playIntent = useRef(false),
    sourceGeneration = useRef(0),
    failureCount = useRef(0),
    rangeEnd = useRef<number | null>(null);
  const [current, setCurrent] = useState(0),
    [playing, setPlaying] = useState(false),
    [error, setError] = useState<PreviewError | null>(null),
    [info, setInfo] = useState<PreviewInfo | null>(null),
    [waveform, setWaveform] = useState<Waveform | undefined>(),
    [retry, setRetry] = useState(0),
    [ranges, setRanges] = useState<PreviewRange[]>([]);
  useEffect(() => {
    onTimeChange?.(current);
  }, [current, onTimeChange]);
  const duration = document.clips.reduce(
      (n, c) => n + c.interval.endUs - c.interval.startUs,
      0,
    ),
    active = clipAt(document.clips, Math.min(current, duration)),
    clip = document.clips[active.index];
  const sourceJson = JSON.stringify(clip.source),
    source = useMemo(
      () => mediaVersionRefSchema.parse(JSON.parse(sourceJson)),
      [sourceJson],
    ),
    documentRef = useRef(document);
  documentRef.current = document;
  const layout = useMemo(() => {
    let offset = 0;
    return document.clips.map((c, i) => {
      const item = {
        id: c.id,
        startUs: offset,
        endUs: offset + c.interval.endUs - c.interval.startUs,
        label: `clip ${i + 1}`,
        minUs: offset - c.interval.startUs,
        maxUs: offset + c.sourceDurationUs - c.interval.startUs,
      };
      offset = item.endUs;
      return item;
    });
  }, [document.clips]);
  const seek = useCallback(
    (us: number) => {
      rangeEnd.current = null;
      const safe = Math.max(0, Math.min(duration, Math.round(us)));
      timeRef.current = safe;
      setCurrent(safe);
      const next = clipAt(document.clips, safe);
      if (next.index === active.index) controller.current?.seek(next.sourceUs);
    },
    [duration, active.index, document.clips],
  );
  useEffect(() => {
    const media = video.current;
    if (!media) return;
    let currentGeneration = ++sourceGeneration.current;
    let disposed = false;
    setError(null);
    setInfo(null);
    setWaveform(undefined);
    failureCount.current = 0;
    const open = async () => {
      const value = await resolve(source);
      if (value.hash !== source.hash || value.versionId !== source.versionId)
        throw new PlaybackError("SOURCE_MISSING");
      return value;
    };
    void open()
      .then((value) => {
        if (disposed || sourceGeneration.current !== currentGeneration) return;
        setInfo(value);
        const next = new PlaybackController(
          media,
          async () => {
            const renewed = await open();
            if (!disposed) setInfo(renewed);
            return { url: renewed.proxy, mapping: renewed.mapping };
          },
          value.mapping,
        );
        controller.current = next;
        media.src = value.proxy;
        next.seek(clipAt(documentRef.current.clips, timeRef.current).sourceUs);
        media.load();
      })
      .catch((e) => {
        if (!disposed)
          setError(e instanceof PlaybackError ? e.code : "PLAYBACK_FAILED");
      });
    return () => {
      disposed = true;
      currentGeneration++;
      controller.current?.dispose();
      controller.current = null;
    };
  }, [source, resolve, retry]);
  useEffect(() => {
    if (!info) return;
    const stop = new AbortController();
    void loadWaveform(info, stop.signal)
      .then((value) => {
        if (!stop.signal.aborted) setWaveform(value);
      })
      .catch(() => {
        if (!stop.signal.aborted) setWaveform(undefined);
      });
    return () => stop.abort();
  }, [info]);
  useEffect(() => {
    controller.current?.seek(
      clipAt(documentRef.current.clips, timeRef.current).sourceUs,
    );
    if (playIntent.current)
      void controller.current
        ?.playFromGesture()
        .catch(() => setError("PLAYBACK_FAILED"));
  }, [active.index, clip.interval.startUs, clip.interval.endUs]);
  useEffect(() => {
    const media = video.current;
    if (!media) return;
    let frame: number | undefined;
    const update = () => {
      const clock = controller.current;
      if (!clock || !media.readyState) return;
      const sourceUs = clock.currentUs();
      if (sourceUs >= clip.interval.endUs) {
        if (active.index < document.clips.length - 1) {
          seek(layout[active.index].endUs);
          return;
        }
        clock.pause();
        playIntent.current = false;
        setPlaying(false);
        seek(duration);
        return;
      }
      const global =
        layout[active.index].startUs +
        Math.max(0, sourceUs - clip.interval.startUs);
      if (
        mode === "fnf" &&
        rangeEnd.current !== null &&
        global >= rangeEnd.current
      ) {
        const limit = rangeEnd.current;
        clock.pause();
        playIntent.current = false;
        setPlaying(false);
        seek(limit);
        return;
      }
      timeRef.current = global;
      setCurrent(Math.min(duration, global));
    };
    const loaded = () => {
      controller.current?.loaded();
      if (playIntent.current)
        void controller.current?.playFromGesture().catch(() => {
          setError("PLAYBACK_FAILED");
          playIntent.current = false;
        });
    };
    media.addEventListener("timeupdate", update);
    media.addEventListener("loadedmetadata", loaded);
    const onFrame = () => {
      update();
      frame = media.requestVideoFrameCallback?.(onFrame);
    };
    frame = media.requestVideoFrameCallback?.(onFrame);
    return () => {
      media.removeEventListener("timeupdate", update);
      media.removeEventListener("loadedmetadata", loaded);
      if (frame !== undefined) media.cancelVideoFrameCallback?.(frame);
    };
  }, [clip, active.index, document.clips.length, duration, layout, seek, mode]);
  useEffect(() => {
    const hidden = () => {
      if (window.document.visibilityState === "hidden") {
        const clock = controller.current;
        if (clock) {
          const position = clipAt(documentRef.current.clips, timeRef.current),
            selected = documentRef.current.clips[position.index];
          const sourceUs = Math.max(
            selected.interval.startUs,
            Math.min(selected.interval.endUs, clock.currentUs()),
          );
          timeRef.current =
            position.offsetUs + sourceUs - selected.interval.startUs;
          setCurrent(timeRef.current);
          clock.pause();
        }
        playIntent.current = false;
        setPlaying(false);
      } else if (info && info.expiresAt <= Date.now()) void refresh();
    };
    window.document.addEventListener("visibilitychange", hidden);
    return () =>
      window.document.removeEventListener("visibilitychange", hidden);
  }, [info]);
  async function refresh() {
    const generation = sourceGeneration.current;
    playIntent.current = false;
    setPlaying(false);
    try {
      await controller.current?.refreshAccess();
      if (generation === sourceGeneration.current) setError(null);
    } catch (e) {
      if (generation === sourceGeneration.current)
        setError(e instanceof PlaybackError ? e.code : "PLAYBACK_FAILED");
    }
  }
  function invalid() {
    setError("INVALID_INTERVAL");
  }
  function trim(id: string, start: number, end: number) {
    try {
      if (mode === "fnf") {
        const range = ranges.find((r) => r.id === id)!;
        const next = { ...range, startUs: start, endUs: end };
        validateRange(next, duration);
        setRanges((old) => old.map((r) => (r.id === id ? next : r)));
      } else {
        const item = layout.find((c) => c.id === id)!,
          original = document.clips.find((c) => c.id === id)!;
        const interval = {
          startUs: original.interval.startUs + start - item.startUs,
          endUs: original.interval.endUs + end - item.endUs,
        };
        validateRange(interval, original.sourceDurationUs);
        const next = allVersionsDocumentSchema.parse({
          ...document,
          clips: document.clips.map((c) =>
            c.id === id ? { ...c, interval } : c,
          ),
        });
        onDocumentChange(next);
      }
      setError(null);
    } catch {
      invalid();
    }
  }
  const markers =
    mode === "all-versions"
      ? document.clips.flatMap((c, i) =>
          c.markersUs.map((m) => layout[i].startUs + m - c.interval.startUs),
        )
      : [];
  const timelineItems: TimelineItem[] =
    mode === "fnf"
      ? ranges.map((r, i) => ({ ...r, label: `range ${i + 1}` }))
      : layout;
  return (
    <section aria-label="共通動画preview">
      <div
        style={{
          position: "relative",
          aspectRatio: mode === "all-versions" ? "16 / 9" : "9 / 16",
          maxHeight: "60dvh",
          maxWidth: "100%",
          width:
            mode === "fnf" ? "min(100%, 33.75dvh)" : "min(100%, 106.667dvh)",
          background: "black",
          margin: "auto",
        }}
      >
        <video
          ref={video}
          aria-label="動画preview"
          playsInline
          preload="metadata"
          crossOrigin="anonymous"
          poster={info?.thumbnail}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
          onLoadedData={() => {
            failureCount.current = 0;
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => {
            if (failureCount.current++ === 0) void refresh();
            else setError("PLAYBACK_FAILED");
          }}
        />
        {overlay && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              overflow: "hidden",
            }}
          >
            {overlay}
          </div>
        )}
      </div>
      {error && <p role="alert">{previewMessages[error]}</p>}
      <p>1frame操作は出力60fps基準です。元映像のPTS間隔は保持されます。</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          style={{ minWidth: 44, minHeight: 44 }}
          disabled={!info}
          onClick={() => {
            if (playing) {
              controller.current?.pause();
              playIntent.current = false;
            } else {
              playIntent.current = true;
              void controller.current?.playFromGesture().catch(() => {
                setError("PLAYBACK_FAILED");
                playIntent.current = false;
              });
            }
          }}
        >
          {playing ? "一時停止" : "再生"}
        </button>
        {[-60, -1, 1, 60].map((n) => (
          <button
            key={n}
            style={{ minWidth: 44, minHeight: 44 }}
            onClick={() => seek(stepTime(current, n))}
          >
            {n === -60
              ? "−1秒"
              : n === 60
                ? "＋1秒"
                : n < 0
                  ? "−1frame"
                  : "＋1frame"}
          </button>
        ))}
        <button
          style={{ minWidth: 44, minHeight: 44 }}
          onClick={() => {
            if (controller.current) void refresh();
            else setRetry((n) => n + 1);
          }}
        >
          再認可・再確認
        </button>
        <TimeField
          label="現在時刻"
          value={current}
          onCommit={seek}
          onError={invalid}
        />
        <output aria-label="全長">{formatTime(duration)}</output>
      </div>
      <Timeline
        mode={mode}
        durationUs={duration}
        currentUs={current}
        items={timelineItems}
        markers={markers}
        onSeek={seek}
        onEdit={trim}
        waveform={
          waveform
            ? {
                ...waveform,
                clipStartUs: layout[active.index].startUs,
                clipEndUs: layout[active.index].endUs,
                originUs:
                  waveform.originUs +
                  layout[active.index].startUs -
                  clip.interval.startUs,
              }
            : undefined
        }
      />
      {mode === "all-versions" ? (
        <>
          <button
            style={{ minHeight: 44 }}
            onClick={() => {
              try {
                const position = clipAt(document.clips, current),
                  c = document.clips[position.index];
                if (c.markersUs.includes(position.sourceUs)) throw new Error();
                const next = allVersionsDocumentSchema.parse({
                  ...document,
                  clips: document.clips.map((v, i) =>
                    i === position.index
                      ? {
                          ...v,
                          markersUs: [...v.markersUs, position.sourceUs].sort(
                            (a, b) => a - b,
                          ),
                        }
                      : v,
                  ),
                });
                onDocumentChange(next);
              } catch {
                invalid();
              }
            }}
          >
            現在位置にmarkerを追加
          </button>
          {document.clips.map((c, i) => (
            <fieldset key={c.id}>
              <legend>clip {i + 1}</legend>
              <TimeField
                label={`clip ${i + 1} 開始`}
                value={c.interval.startUs}
                onCommit={(us) =>
                  trim(
                    c.id,
                    layout[i].startUs + us - c.interval.startUs,
                    layout[i].endUs,
                  )
                }
                onError={invalid}
              />
              <TimeField
                label={`clip ${i + 1} 終了`}
                value={c.interval.endUs}
                onCommit={(us) =>
                  trim(
                    c.id,
                    layout[i].startUs,
                    layout[i].endUs + us - c.interval.endUs,
                  )
                }
                onError={invalid}
              />
            </fieldset>
          ))}
        </>
      ) : (
        <>
          <p>
            rangeと譜面名は未送信の作業状態です。この画面では永続保存しません。
          </p>
          <button
            style={{ minHeight: 44 }}
            onClick={() => {
              const startUs = Math.min(
                current,
                Math.max(0, duration - frameTimeUs(1)),
              );
              setRanges((old) => [
                ...old,
                {
                  id: crypto.randomUUID(),
                  startUs,
                  endUs: Math.min(duration, startUs + 1_000_000),
                  name: "",
                },
              ]);
            }}
          >
            独立rangeを追加
          </button>
          {ranges.map((r, i) => (
            <fieldset key={r.id}>
              <legend>range {i + 1}</legend>
              <TimeField
                label={`range ${i + 1} 開始`}
                value={r.startUs}
                onCommit={(us) => trim(r.id, us, r.endUs)}
                onError={invalid}
              />
              <TimeField
                label={`range ${i + 1} 終了`}
                value={r.endUs}
                onCommit={(us) => trim(r.id, r.startUs, us)}
                onError={invalid}
              />
              <button
                style={{ minHeight: 44 }}
                onClick={() => {
                  seek(r.startUs);
                  rangeEnd.current = r.endUs;
                  playIntent.current = true;
                  void controller.current
                    ?.playFromGesture()
                    .catch(() => setError("PLAYBACK_FAILED"));
                }}
              >
                range {i + 1} を再生
              </button>
              <label>
                譜面名
                <input
                  aria-label={`range ${i + 1} 譜面名`}
                  value={r.name}
                  onChange={(e) =>
                    setRanges((old) =>
                      old.map((v) =>
                        v.id === r.id ? { ...v, name: e.target.value } : v,
                      ),
                    )
                  }
                  style={{ minHeight: 44 }}
                />
              </label>
              {[-1, 1].map((n) => (
                <button
                  key={n}
                  style={{ minHeight: 44 }}
                  onClick={() => {
                    try {
                      const moved = moveRange(r, n * 1_000_000, duration);
                      setRanges((old) =>
                        old.map((v) => (v.id === r.id ? moved : v)),
                      );
                    } catch {
                      invalid();
                    }
                  }}
                >
                  range {i + 1} 全体{n > 0 ? "＋" : "−"}1秒
                </button>
              ))}
            </fieldset>
          ))}
        </>
      )}
    </section>
  );
}
