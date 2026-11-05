"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Timeline, type TimelineItem } from "../video-common/Timeline";
import { useLocalWaveform } from "../video-common/useLocalWaveform";
import {
  useWaveformDetail,
  type VisibleWindow,
} from "../video-common/useWaveformDetail";
import {
  bindTrimPlayback,
  clampToTrim,
  trimRanges,
} from "../../services/video/trim-playback";
import type { TimelineState } from "../../services/video/local-project";
export default function LocalTimeline({
  file,
  duration,
  media,
  items,
  markers,
  fnf,
  onEdit,
  onMarkerEdit,
  timeline,
  onTimelineState,
}: {
  timeline?: TimelineState;
  onTimelineState?: (state: TimelineState) => void;
  file: File;
  duration: number;
  media: () => HTMLVideoElement | null;
  items: TimelineItem[];
  markers: number[];
  onMarkerEdit?: (index: number, us: number) => void;
  fnf: boolean;
  onEdit: (id: string, start: number, end: number) => void;
}) {
  const [current, setCurrent] = useState(timeline?.currentUs ?? 0);
  const [editing, setEditing] = useState(timeline?.editing ?? false);
  const [selected, setSelected] = useState(timeline?.selected ?? "");
  const initial = useRef(timeline);
  const [display, setDisplay] = useState({
    zoom: timeline?.zoom ?? 80,
    gain: timeline?.gain ?? 1,
  });
  const updateDisplay = useCallback(
    (zoom: number, gain: number) =>
      setDisplay((old) =>
        old.zoom === zoom && old.gain === gain ? old : { zoom, gain },
      ),
    [],
  );
  useEffect(() => {
    onTimelineState?.({ currentUs: current, editing, selected, ...display });
  }, [current, editing, selected, display, onTimelineState]);
  const [view, setView] = useState<VisibleWindow>();
  const visible = useCallback(
    (next: VisibleWindow) =>
      setView((old) =>
        old &&
        old.start === next.start &&
        old.end === next.end &&
        old.pps === next.pps
          ? old
          : next,
      ),
    [],
  );
  const chosen = items.find((i) => i.id === selected) ?? items[0];
  const ranges = useMemo(
    () =>
      trimRanges(
        (fnf && chosen ? [chosen] : items).map((i) => ({
          start: i.startUs / 1e6,
          end: i.endUs / 1e6,
        })),
        duration,
      ),
    [fnf, chosen, items, duration],
  );
  const bounds = useMemo(
    () => ({ startUs: ranges[0].start * 1e6, endUs: ranges.at(-1)!.end * 1e6 }),
    [ranges],
  );
  const analysis = useLocalWaveform(file, duration);
  const detail = useWaveformDetail(
    file,
    duration,
    view,
    analysis.status === "complete",
  );
  const waveform = useMemo(
    () =>
      analysis.waveform
        ? {
            ...(detail.waveform ?? analysis.waveform),
            clipStartUs: detail.waveform?.originUs ?? 0,
            clipEndUs: detail.waveform
              ? detail.waveform.originUs +
                (detail.waveform.levels[0].stepUs *
                  detail.waveform.levels[0].peaks.length) /
                  2
              : analysis.analyzedUntilUs,
          }
        : undefined,
    [analysis.waveform, analysis.analyzedUntilUs, detail.waveform],
  );
  useEffect(() => {
    const video = media();
    if (!video || !initial.current) return;
    const target = initial.current.currentUs / 1e6;
    const restore = () => {
      video.currentTime = target;
      initial.current = undefined;
    };
    if (video.readyState >= 1) restore();
    else video.addEventListener("loadedmetadata", restore, { once: true });
    return () => video.removeEventListener("loadedmetadata", restore);
  }, [media]);
  const rangeKey = JSON.stringify(ranges);
  useEffect(() => {
    const video = media();
    if (!video) return;
    const update = () => setCurrent(video.currentTime * 1e6);
    const release = bindTrimPlayback(video, JSON.parse(rangeKey));
    video.addEventListener("timeupdate", update);
    update();
    return () => {
      release();
      video.removeEventListener("timeupdate", update);
    };
  }, [media, rangeKey]);
  const busy = analysis.status === "queued" || analysis.status === "analyzing";
  const messages = {
    queued: "音声波形の解析待ち…",
    analyzing: `音声波形を解析中 ${Math.floor(analysis.progress * 100)}%（編集できます）`,
    complete: "音声波形の解析完了",
    "no-audio": "音声トラックがありません。",
    cancelled: "波形解析をキャンセルしました。編集・書き出しは利用できます。",
    paused: "画面の中断により波形解析を停止しました。再解析できます。",
    failed:
      "この素材の音声形式を端末で解析できません。編集・書き出しは利用できます。",
  };
  return (
    <section aria-label="素材のタイムライン">
      <p role="status">
        {messages[analysis.status]}{" "}
        {analysis.status === "failed" ? analysis.reason : ""}
      </p>
      {busy && (
        <button type="button" onClick={analysis.cancel}>
          波形解析をキャンセル
        </button>
      )}
      {["cancelled", "paused", "failed"].includes(analysis.status) && (
        <button type="button" onClick={analysis.retry}>
          波形を再解析
        </button>
      )}
      <button
        type="button"
        aria-pressed={editing}
        onClick={() => setEditing((v) => !v)}
      >
        {editing ? "通常再生に戻る" : "トリミング範囲を編集"}
      </button>
      {fnf && items.length > 0 && (
        <label>
          再生する範囲
          <select
            aria-label="再生する範囲"
            value={chosen?.id}
            onChange={(e) => setSelected(e.target.value)}
          >
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <p>
        残る長さ：{((bounds.endUs - bounds.startUs) / 1e6).toFixed(3)}秒。
        {editing
          ? "暗い部分は除外範囲です。ツマミで再び含められます。"
          : "通常操作は選択したトリミング範囲内に制限されます。"}
      </p>
      <p role="status">{detail.status}</p>
      <Timeline
        onMarkerEdit={onMarkerEdit}
        initialZoom={timeline?.zoom}
        initialGain={timeline?.gain}
        onDisplayChange={updateDisplay}
        bounds={bounds}
        editing={editing}
        media={media}
        onVisibleWindow={visible}
        mode={fnf ? "fnf" : "all-versions"}
        durationUs={Math.round(duration * 1e6)}
        currentUs={current}
        items={items}
        markers={markers}
        waveform={waveform}
        onSeek={(us) => {
          const video = media();
          const target = clampToTrim(us / 1e6, ranges);
          if (video) video.currentTime = target;
          setCurrent(target * 1e6);
        }}
        onEdit={(id, start, end) => onEdit(id, start / 1e6, end / 1e6)}
      />
    </section>
  );
}
