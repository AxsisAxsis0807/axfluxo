"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nearestBoundary } from "../../services/video/timeline-math";
import SmartBoundaries from "./SmartBoundaries";
import {
  DEFAULT_BOUNDARY_SETTINGS,
  recommendedBoundary,
  sourceKey,
  BOUNDARY_ALGORITHM,
} from "../../services/video/track-boundaries";
import { formatTime } from "../../services/video/time";
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
  onMarkerAdd,
  onMarkerDelete,
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
  onMarkerAdd?: (us: number) => void;
  onMarkerDelete?: (index: number) => void;
  onMarkerEdit?: (index: number, us: number) => void;
  fnf: boolean;
  onEdit: (id: string, start: number, end: number) => void;
}) {
  const [navigation, setNavigation] = useState<{
    us: number;
    revision: number;
  }>();
  const [current, setCurrent] = useState(timeline?.currentUs ?? 0);
  const [editing, setEditing] = useState(timeline?.editing ?? false);
  const [selected, setSelected] = useState(timeline?.selected ?? "");
  const [boundarySettings, setBoundarySettings] = useState(
    timeline?.boundarySettings ??
      timeline?.detection?.settings ??
      DEFAULT_BOUNDARY_SETTINGS,
  );
  const [boundaryPlacement, setBoundaryPlacement] = useState(
    timeline?.boundaryPlacement ?? "middle",
  );
  const [detection, setDetection] = useState(timeline?.detection);
  const [selectedBoundary, setSelectedBoundary] = useState(
    timeline?.selectedBoundary ?? "",
  );
  const [snapEnabled, setSnapEnabled] = useState(timeline?.snapEnabled ?? true);
  const [boundaryError, setBoundaryError] = useState("");
  // Editing time includes the closed out-point; native decoders expose samples
  // in [0, duration) and may reset to zero when asked to seek exactly to EOF.
  const cursorSeek = useRef<{ us: number; pending: boolean } | null>(
    timeline ? { us: timeline.currentUs, pending: false } : null,
  );
  const writeMediaSeek = useCallback(
    (video: HTMLVideoElement, us: number) => {
      const physical = Math.max(0, Math.min(us, duration * 1e6 - 1)) / 1e6;
      const pending = Math.abs(video.currentTime - physical) > 0.0000005;
      cursorSeek.current = { us, pending };
      setCurrent(us);
      if (pending) video.currentTime = physical;
    },
    [duration],
  );
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
    onTimelineState?.({
      currentUs: current,
      editing,
      selected,
      ...display,
      detection,
      boundarySettings,
      boundaryPlacement,
      selectedBoundary,
      snapEnabled,
    });
  }, [
    current,
    editing,
    selected,
    display,
    detection,
    boundaryPlacement,
    selectedBoundary,
    snapEnabled,
    onTimelineState,
    boundarySettings,
  ]);
  const [detecting, setDetecting] = useState(false);
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
    analysis.status === "complete" && !detecting,
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
    const target = initial.current.currentUs;
    const restore = () => {
      if (!initial.current) return;
      const hasFrame = video.readyState >= 2;
      writeMediaSeek(video, cursorSeek.current?.us ?? target);
      // Safari can discard a seek issued at metadata-only readiness. Reapply
      // once the first frame is ready before accepting native seek echoes.
      if (hasFrame) initial.current = undefined;
    };
    video.addEventListener("loadedmetadata", restore, { once: true });
    video.addEventListener("loadeddata", restore, { once: true });
    if (video.readyState >= 1) restore();
    return () => {
      video.removeEventListener("loadedmetadata", restore);
      video.removeEventListener("loadeddata", restore);
    };
  }, [media, writeMediaSeek]);
  const rangeKey = JSON.stringify(
    editing ? [{ start: 0, end: duration }] : ranges,
  );
  useEffect(() => {
    const video = media();
    if (!video) return;
    const update = () =>
      setCurrent(
        (video.paused || video.ended) && cursorSeek.current
          ? cursorSeek.current.us
          : video.currentTime * 1e6,
      );
    const seeking = () => {
      if (!cursorSeek.current?.pending && !initial.current)
        cursorSeek.current = null;
    };
    const seeked = () => {
      if (cursorSeek.current) cursorSeek.current.pending = false;
      update();
    };
    const nativeControl = () => {
      initial.current = undefined;
      cursorSeek.current = null;
    };
    const play = () => {
      nativeControl();
      update();
    };
    const ended = () => {
      cursorSeek.current = { us: duration * 1e6, pending: false };
      update();
    };
    const playbackRanges = JSON.parse(rangeKey);
    if (!editing && cursorSeek.current) {
      const target =
        clampToTrim(cursorSeek.current.us / 1e6, playbackRanges) * 1e6;
      if (Math.abs(target - cursorSeek.current.us) > 0.5)
        writeMediaSeek(video, target);
    }
    const release = bindTrimPlayback(video, playbackRanges);
    video.addEventListener("timeupdate", update);
    video.addEventListener("seeking", seeking);
    video.addEventListener("seeked", seeked);
    video.addEventListener("play", play);
    video.addEventListener("ended", ended);
    video.addEventListener("pointerdown", nativeControl);
    video.addEventListener("keydown", nativeControl);
    update();
    return () => {
      release();
      video.removeEventListener("timeupdate", update);
      video.removeEventListener("seeking", seeking);
      video.removeEventListener("seeked", seeked);
      video.removeEventListener("play", play);
      video.removeEventListener("ended", ended);
      video.removeEventListener("pointerdown", nativeControl);
      video.removeEventListener("keydown", nativeControl);
    };
  }, [media, rangeKey, duration, editing, writeMediaSeek]);
  const mediaRef = useRef(media);
  mediaRef.current = media;
  useEffect(() => {
    if (!navigation) return;
    const video = mediaRef.current();
    if (video) writeMediaSeek(video, navigation.us);
  }, [navigation, writeMediaSeek]);
  function seek(us: number) {
    const video = media();
    const target = editing
      ? Math.max(0, Math.min(duration, us / 1e6))
      : clampToTrim(us / 1e6, ranges);
    if (video) writeMediaSeek(video, target * 1e6);
    setCurrent(target * 1e6);
  }
  function applyBoundary(us: number) {
    setBoundaryError("");
    if (selectedBoundary.startsWith("marker:")) {
      const index = Number(selectedBoundary.slice(7));
      const lower = markers[index - 1] ?? items[0]?.startUs ?? 0;
      const upper = markers[index + 1] ?? items.at(-1)?.endUs ?? duration * 1e6;
      if (markers[index] !== undefined && us > lower && us < upper) {
        onMarkerEdit?.(index, us);
        return;
      }
    } else {
      const edge = selectedBoundary.endsWith(":start") ? "start" : "end";
      const item = items.find((i) => `${i.id}:${edge}` === selectedBoundary);
      if (
        item &&
        us >= 0 &&
        us <= duration * 1e6 &&
        (edge === "start" ? us < item.endUs - 16667 : us > item.startUs + 16667)
      ) {
        if (
          !fnf &&
          markers.some((m) => (edge === "start" ? m <= us : m >= us))
        ) {
          setBoundaryError("既存のVersion境界を越える適用はできません。");
          return;
        }
        onEdit(
          item.id,
          (edge === "start" ? us : item.startUs) / 1e6,
          (edge === "end" ? us : item.endUs) / 1e6,
        );
        return;
      }
    }
    setBoundaryError(
      "境界ハンドルを選択し、隣接境界・切り取り範囲内の候補を適用してください。",
    );
  }
  const overlapping = nearestBoundary(markers, current, display.zoom);
  const validDetection =
    detection?.sourceKey === sourceKey(file) &&
    detection.algorithm === BOUNDARY_ALGORITHM
      ? detection
      : undefined;
  const selectedTime = selectedBoundary.startsWith("marker:")
    ? markers[Number(selectedBoundary.slice(7))]
    : items
        .flatMap((i) => [
          { id: `${i.id}:start`, time: i.startUs },
          { id: `${i.id}:end`, time: i.endUs },
        ])
        .find((i) => i.id === selectedBoundary)?.time;
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
      <output aria-label="中央プレイヘッド時刻">
        {(current / 1e6).toFixed(6)} 秒
      </output>
      {!fnf && onMarkerAdd && (
        <button
          onClick={() => {
            setBoundaryError("");
            if (overlapping >= 0 && onMarkerDelete) {
              onMarkerDelete(overlapping);
              setSelectedBoundary("");
              return;
            }
            if (
              current <= bounds.startUs ||
              current >= bounds.endUs ||
              markers.includes(current)
            ) {
              setBoundaryError(
                "切り取り範囲内で、既存境界と異なる位置に移動してください。",
              );
              return;
            }
            onMarkerAdd(Math.round(current));
            setSelectedBoundary(
              `marker:${markers.filter((m) => m < current).length}`,
            );
          }}
        >
          {overlapping >= 0 && onMarkerDelete
            ? "Version境界を削除"
            : "Version境界を追加"}
        </button>
      )}
      <label>
        <input
          type="checkbox"
          checked={snapEnabled}
          onChange={(e) => setSnapEnabled(e.target.checked)}
        />
        境界の吸着（中央・曲間候補）
      </label>
      <p style={{ minHeight: "3em" }}>
        選択中：
        {selectedBoundary.startsWith("marker:")
          ? `Version境界 ${Number(selectedBoundary.slice(7)) + 1}`
          : items.find((i) => selectedBoundary.startsWith(`${i.id}:`))?.label
            ? `${items.find((i) => selectedBoundary.startsWith(`${i.id}:`))!.label} ${selectedBoundary.endsWith(":start") ? "開始" : "終了"}`
            : "境界をタップしてください"}{" "}
        {selectedTime === undefined ? "" : formatTime(selectedTime)}
        。吸着を解除して微調整できます。
      </p>
      {boundaryError && <p role="alert">{boundaryError}</p>}
      <Timeline
        navigation={navigation}
        selectedBoundary={selectedBoundary}
        onBoundarySelect={setSelectedBoundary}
        snapEnabled={snapEnabled}
        candidates={validDetection?.candidates
          .filter((c) => c.startUs > bounds.startUs && c.endUs < bounds.endUs)
          .map((c) => ({
            ...c,
            timeUs: recommendedBoundary(c, boundaryPlacement),
          }))}
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
        onSeek={seek}
        onEdit={(id, start, end) => onEdit(id, start / 1e6, end / 1e6)}
      />
      <SmartBoundaries
        onBusy={setDetecting}
        settings={boundarySettings}
        onSettings={setBoundarySettings}
        placement={boundaryPlacement}
        onPlacement={setBoundaryPlacement}
        file={file}
        duration={duration}
        analysis={validDetection}
        onChange={setDetection}
        currentUs={current}
        onSeek={(us) => {
          if (us < bounds.startUs || us > bounds.endUs) setEditing(true);
          cursorSeek.current = { us, pending: true };
          setCurrent(us);
          setNavigation({ us, revision: performance.now() });
        }}
        onApply={
          fnf
            ? applyBoundary
            : (us) => {
                if (
                  us > bounds.startUs &&
                  us < bounds.endUs &&
                  !markers.includes(us)
                )
                  onMarkerAdd?.(us);
              }
        }
        media={media}
        bounds={bounds}
      />
    </section>
  );
}
