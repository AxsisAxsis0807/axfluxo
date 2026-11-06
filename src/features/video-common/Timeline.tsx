"use client";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import type { BoundaryCandidate } from "../../services/video/track-boundaries";
import type { Waveform } from "../../domain/video/preview";
import { formatTime, frameTimeUs } from "../../services/video/time";
import {
  centerTime,
  snapMarker,
  waveformHeight,
  tickInterval,
  trimEdgeLimits,
} from "../../services/video/timeline-math";
export type TimelineItem = {
  id: string;
  startUs: number;
  endUs: number;
  label: string;
  minUs?: number;
  maxUs?: number;
};
type Drag = {
  kind: string;
  id: string;
  startX: number;
  startY: number;
  scroll: number;
  scrollY: number;
  original: TimelineItem;
  delta: number;
  snapped?: boolean;
  axis?: "x" | "y";
  pageY: number;
};
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
type TimelineWaveform = Waveform & { clipStartUs?: number; clipEndUs?: number };

function LaneWaveform({
  waveform,
  startUs,
  endUs,
  width,
  left,
  gain,
}: {
  waveform?: TimelineWaveform;
  startUs: number;
  endUs: number;
  width: number;
  left: number;
  gain: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvas.current;
    if (!node || width <= 0) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    node.width = Math.ceil(width * ratio);
    node.height = 88 * ratio;
    const ctx = node.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    const stepUs = (endUs - startUs) / width;
    const levels = [...(waveform?.levels ?? [])].sort(
      (a, b) => b.stepUs - a.stepUs,
    );
    const level =
      levels.find((level) => level.stepUs <= stepUs) ?? levels.at(-1);
    if (!level) return;
    ctx.fillStyle = "#b899c9";
    // Aggregate every peak covered by a bar so short transients survive zooming out.
    const barUs = Math.max(stepUs, level.stepUs);
    const stride = barUs / stepUs;
    const offset = (waveform?.originUs ?? 0) - startUs;
    const firstBar = Math.floor(-offset / barUs);
    for (let x = (offset + firstBar * barUs) / stepUs; x < width; x += stride) {
      const start = Math.max(
        startUs + x * stepUs,
        waveform?.clipStartUs ?? -Infinity,
      );
      const end = Math.min(
        startUs + (x + stride) * stepUs,
        endUs,
        waveform?.clipEndUs ?? Infinity,
      );
      if (end <= start) continue;
      const first = Math.max(
        0,
        Math.floor((start - (waveform?.originUs ?? 0)) / level.stepUs),
      );
      const last = Math.min(
        level.peaks.length / 2,
        Math.ceil((end - (waveform?.originUs ?? 0)) / level.stepUs),
      );
      let amplitude = 0;
      for (let i = first; i < last; i++) {
        amplitude = Math.max(
          amplitude,
          Math.abs(level.peaks[i * 2]),
          Math.abs(level.peaks[i * 2 + 1]),
        );
      }
      if (last <= first) continue;
      if (amplitude === 0) continue;
      const height = waveformHeight(amplitude, gain);
      ctx.fillRect(x, (88 - height) / 2, Math.min(stride, width - x), height);
    }
  }, [waveform, startUs, endUs, width, gain]);
  return (
    <canvas
      ref={canvas}
      aria-label="音声波形"
      style={{
        position: "absolute",
        left,
        top: 0,
        width,
        height: 88,
        pointerEvents: "none",
      }}
    />
  );
}

export function Timeline({
  mode,
  durationUs,
  currentUs,
  items,
  markers,
  onSeek,
  onEdit,
  waveform,
  bounds,
  editing = true,
  media,
  onVisibleWindow,
  onMarkerEdit,
  navigation,
  selectedBoundary,
  onBoundarySelect,
  candidates = [],
  snapEnabled = true,
  initialZoom = 80,
  initialGain = 1,
  onDisplayChange,
}: {
  navigation?: { us: number; revision: number };
  selectedBoundary?: string;
  onBoundarySelect?: (id: string) => void;
  candidates?: BoundaryCandidate[];
  snapEnabled?: boolean;
  initialZoom?: number;
  initialGain?: number;
  onDisplayChange?: (zoom: number, gain: number) => void;
  mode: "all-versions" | "fnf";
  durationUs: number;
  currentUs: number;
  items: TimelineItem[];
  markers: number[];
  onMarkerEdit?: (index: number, us: number) => void;
  onSeek: (us: number) => void;
  onEdit: (id: string, startUs: number, endUs: number) => void;
  waveform?: TimelineWaveform;
  bounds?: { startUs: number; endUs: number };
  editing?: boolean;
  media?: () => HTMLVideoElement | null;
  onVisibleWindow?: (view: { start: number; end: number; pps: number }) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    points = useRef(new Map<number, { x: number; y: number }>()),
    drag = useRef<Drag | null>(null),
    pendingDraft = useRef<TimelineItem | null>(null),
    pinch = useRef<{ distance: number; zoom: number; anchor: number } | null>(
      null,
    ),
    autoScroll = useRef<number | null>(null),
    pendingScroll = useRef<number | null>(null);
  const [zoom, setZoom] = useState(initialZoom),
    [origin, setOrigin] = useState(0),
    [scroll, setScroll] = useState(0),
    [width, setWidth] = useState(600),
    [draft, setDraft] = useState<TimelineItem | null>(null);
  const [gain, setGain] = useState(initialGain);
  useEffect(() => {
    onDisplayChange?.(zoom, gain);
  }, [zoom, gain, onDisplayChange]);
  const head = useRef<HTMLDivElement>(null);
  const manualUntil = useRef(0);
  const lastScrollPublish = useRef(0);
  const wasPlaying = useRef(false);
  const minTime = bounds && !editing ? bounds.startUs : 0;
  const maxTime = bounds && !editing ? bounds.endUs : durationUs;
  const pps = zoom,
    spanUs = Math.min(maxTime - minTime, (8_000_000 / pps) * 1_000_000),
    padding = width / 2,
    trackWidth = Math.max(width, (spanUs / 1_000_000) * pps + 2 * padding);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (navigation) manualUntil.current = 0;
  }, [navigation]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (origin < minTime || origin + spanUs > maxTime) {
      setOrigin(clamp(origin, minTime, Math.max(minTime, maxTime - spanUs)));
      return;
    }
    if (pendingScroll.current !== null) {
      node.scrollLeft = pendingScroll.current;
      autoScroll.current = node.scrollLeft;
      pendingScroll.current = null;
      setScroll(node.scrollLeft);
      if (head.current)
        head.current.style.left = `${node.scrollLeft + width / 2}px`;
      return;
    }
    if (points.current.size || performance.now() < manualUntil.current) return;
    if (currentUs < origin || currentUs > origin + spanUs) {
      setOrigin(
        clamp(
          currentUs - spanUs / 2,
          minTime,
          Math.max(minTime, maxTime - spanUs),
        ),
      );
      return;
    }
    {
      const target = ((currentUs - origin) / 1_000_000) * pps;
      autoScroll.current = target;
      node.scrollLeft = target;
    }
  }, [
    currentUs,
    navigation,
    origin,
    spanUs,
    durationUs,
    pps,
    mode,
    width,
    padding,
    minTime,
    maxTime,
    bounds,
    media,
  ]);
  function changeZoom(next: number, fixedAnchor?: number) {
    const node = viewport.current;
    if (!node) return;
    manualUntil.current = Infinity;
    const anchorX = width / 2;
    const anchorUs =
        fixedAnchor ??
        origin + ((node.scrollLeft + anchorX - padding) / pps) * 1_000_000,
      newZoom = clamp(next, 0.2, 192000),
      newSpan = Math.min(maxTime - minTime, (8_000_000 / newZoom) * 1_000_000),
      newOrigin = clamp(
        anchorUs - newSpan / 2,
        minTime,
        Math.max(minTime, maxTime - newSpan),
      );
    pendingScroll.current =
      ((anchorUs - newOrigin) / 1_000_000) * newZoom + padding - anchorX;
    setOrigin(newOrigin);
    setZoom(newZoom);
  }
  function down(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const node = event.currentTarget;
    manualUntil.current = Infinity;
    event.preventDefault();
    pendingDraft.current = null;
    try {
      node.setPointerCapture(event.pointerId);
    } catch {
      /* Pointer may already have been cancelled by the browser. */
    }
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.current.size === 2) {
      drag.current = null;
      pendingDraft.current = null;
      setDraft(null);
      const [a, b] = Array.from(points.current.values());
      pinch.current = {
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        zoom,
        anchor:
          Math.abs(
            ((origin + (node.scrollLeft / pps) * 1e6 - currentUs) / 1e6) * pps,
          ) < 1.5
            ? currentUs
            : origin + (node.scrollLeft / pps) * 1e6,
      };
      return;
    }
    if (points.current.size !== 1) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-action]",
      ),
      item = items.find((i) => i.id === target?.dataset.id);
    if (target?.dataset.action === "marker")
      onBoundarySelect?.(`marker:${target.dataset.index}`);
    else if (item && ["start", "end"].includes(target?.dataset.action ?? ""))
      onBoundarySelect?.(`${item.id}:${target!.dataset.action}`);
    drag.current = {
      kind: target?.dataset.action ?? "pan",
      id: item?.id ?? "",
      startX: event.clientX,
      startY: event.clientY,
      scroll: node.scrollLeft,
      scrollY: node.scrollTop,
      pageY: window.scrollY,
      original: item ?? {
        id: target?.dataset.index ?? "",
        startUs: Number(target?.dataset.time ?? 0),
        endUs: 0,
        label: "",
      },
      delta: 0,
    };
  }
  function snapToTarget(
    value: number,
    center: number,
    latched: boolean,
    bypass: boolean,
  ) {
    if (!snapEnabled || bypass) return { value, snapped: false };
    const targets = [center, ...candidates.map((c) => c.timeUs)];
    const closest = targets.reduce((a, b) =>
      Math.abs(b - value) < Math.abs(a - value) ? b : a,
    );
    return snapMarker(value, closest, pps, latched);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!points.current.has(event.pointerId)) return;
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && points.current.size >= 2) {
      const [a, b] = Array.from(points.current.values());
      changeZoom(
        (pinch.current.zoom * Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))) /
          pinch.current.distance,
        pinch.current.anchor,
      );
      return;
    }
    const d = drag.current;
    if (!d) return;
    d.delta = event.clientX - d.startX;
    if (d.kind === "pan") {
      const dy = event.clientY - d.startY;
      if (!d.axis && Math.max(Math.abs(d.delta), Math.abs(dy)) > 6)
        d.axis = Math.abs(dy) > Math.abs(d.delta) ? "y" : "x";
      if (d.axis === "y") {
        const desired = d.scrollY - dy;
        event.currentTarget.scrollTop = desired;
        window.scrollTo(
          window.scrollX,
          d.pageY + desired - event.currentTarget.scrollTop,
        );
      } else event.currentTarget.scrollLeft = d.scroll - d.delta;
      return;
    }
    const delta = Math.round((d.delta / pps) * 1e6),
      base = d.original,
      min = base.minUs ?? 0,
      max = base.maxUs ?? durationUs;
    const center = centerTime(
      origin,
      event.currentTarget.scrollLeft,
      pps,
      minTime,
      maxTime,
    );
    if (d.kind === "marker") {
      const snap = snapToTarget(
        base.startUs + delta,
        center,
        Boolean(d.snapped),
        event.altKey,
      );
      d.snapped = snap.snapped;
      const index = Number(base.id);
      const lower = markers[index - 1] ?? items[0]?.startUs ?? minTime;
      const upper = markers[index + 1] ?? items.at(-1)?.endUs ?? maxTime;
      if (upper - lower > 1) {
        pendingDraft.current = {
          ...base,
          startUs: Math.round(clamp(snap.value, lower + 1, upper - 1)),
        };
        setDraft(pendingDraft.current);
      }
      return;
    }
    const raw = (d.kind === "end" ? base.endUs : base.startUs) + delta;
    const snap = snapToTarget(raw, center, Boolean(d.snapped), event.altKey);
    d.snapped = snap.snapped;
    const snappedDelta =
      snap.value - (d.kind === "end" ? base.endUs : base.startUs);
    let start = base.startUs,
      end = base.endUs;
    const limits = trimEdgeLimits(
      base,
      durationUs,
      frameTimeUs(1),
      mode === "all-versions" && onMarkerEdit ? markers : [],
    );
    if (d.kind === "start")
      start = clamp(start + snappedDelta, limits.startMin, limits.startMax);
    if (d.kind === "end")
      end = clamp(end + snappedDelta, limits.endMin, limits.endMax);
    if (d.kind === "move") {
      start = clamp(start + delta, min, max - (end - start));
      end = start + (base.endUs - base.startUs);
    }
    pendingDraft.current = {
      ...base,
      startUs: Math.round(start),
      endUs: Math.round(end),
    };
    setDraft(pendingDraft.current);
  }
  function clear(node: HTMLDivElement) {
    manualUntil.current = Infinity;
    const captured = [...points.current.keys()];
    points.current.clear();
    for (const id of captured)
      if (node.hasPointerCapture(id)) node.releasePointerCapture(id);
    pinch.current = null;
    drag.current = null;
    pendingDraft.current = null;
    setDraft(null);
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    if (!points.current.has(event.pointerId)) return;
    if (!pinch.current) move(event);
    const d = drag.current,
      finalDraft = pendingDraft.current,
      isPinch = Boolean(pinch.current);
    points.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (isPinch) {
      if (!points.current.size) {
        onSeek(Math.round(pinch.current!.anchor));
        clear(event.currentTarget);
      }
      return;
    }
    if (d && finalDraft) {
      if (d.kind === "marker")
        onMarkerEdit?.(Number(d.original.id), finalDraft.startUs);
      else onEdit(d.id, finalDraft.startUs, finalDraft.endUs);
    } else if (d?.kind === "pan" && d.axis !== "y" && Math.abs(d.delta) < 4) {
      const x =
        event.clientX - event.currentTarget.getBoundingClientRect().left;
      const target = clamp(
        origin + ((event.currentTarget.scrollLeft + x - padding) / pps) * 1e6,
        minTime,
        maxTime,
      );
      event.currentTarget.scrollLeft = ((target - origin) / 1e6) * pps;
      onSeek(Math.round(target));
    }
    clear(event.currentTarget);
  }
  useEffect(() => {
    onVisibleWindow?.({
      start: Math.max(minTime, origin + ((scroll - padding) / pps) * 1e6) / 1e6,
      end:
        Math.min(maxTime, origin + ((scroll + width - padding) / pps) * 1e6) /
        1e6,
      pps,
    });
  }, [origin, scroll, width, padding, pps, minTime, maxTime, onVisibleWindow]);
  useEffect(() => {
    if (!bounds || !media) return;
    let frame = 0;
    const draw = () => {
      const video = media(),
        node = viewport.current;
      if (video && node && head.current) {
        if (!wasPlaying.current && !video.paused) manualUntil.current = 0;
        wasPlaying.current = !video.paused;
        const time = clamp(
          video.currentTime * 1e6,
          bounds.startUs,
          bounds.endUs,
        );
        const x = padding + ((time - origin) / 1e6) * pps;
        head.current.style.left = `${node.scrollLeft + width / 2}px`;
        if (
          !video.paused &&
          !points.current.size &&
          performance.now() >= manualUntil.current
        ) {
          if (time < origin || time > origin + spanUs)
            setOrigin(
              clamp(
                time - spanUs / 2,
                minTime,
                Math.max(minTime, maxTime - spanUs),
              ),
            );
          const target = clamp(
            x - width / 2,
            0,
            Math.max(0, trackWidth - width),
          );
          autoScroll.current = target;
          node.scrollLeft = target;
          autoScroll.current = node.scrollLeft;
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [
    bounds,
    media,
    origin,
    padding,
    pps,
    width,
    trackWidth,
    spanUs,
    minTime,
    maxTime,
  ]);
  const tickSeconds = tickInterval(pps);
  const firstTick = Math.ceil(
    Math.max(minTime, origin + ((scroll - padding) / pps) * 1e6) /
      1e6 /
      tickSeconds,
  );
  const tickCount = Math.min(100, Math.ceil(width / pps / tickSeconds) + 2);
  const display = items.map((item) => (draft?.id === item.id ? draft : item));
  return (
    <section aria-label="動画timeline">
      <div>
        <button
          style={{ minWidth: 44, minHeight: 44 }}
          onClick={() => changeZoom(zoom / 1.5)}
        >
          縮小
        </button>
        <button
          style={{ minWidth: 44, minHeight: 44 }}
          onClick={() => changeZoom(zoom * 1.5)}
        >
          拡大
        </button>
        <output aria-label="timeline倍率">{zoom.toFixed(1)} px/秒</output>
      </div>
      <label>
        波形の表示倍率（音量は変わりません）
        <select value={gain} onChange={(e) => setGain(Number(e.target.value))}>
          {[1, 10, 100, 1000].map((value) => (
            <option key={value} value={value}>
              {value}倍
            </option>
          ))}
        </select>
      </label>
      <p style={{ fontSize: 12 }}>
        {editing
          ? "左右のツマミをドラッグして切り取り範囲を調整"
          : "タップでシーク・ドラッグで移動・2本指で拡大。矢印キーで微調整。"}
      </p>
      <output
        aria-live="polite"
        style={{
          fontSize: 12,
          display: "block",
          minHeight: "3em",
          lineHeight: 1.5,
        }}
      >
        {draft
          ? drag.current?.kind === "marker"
            ? `Version境界 ${Number(draft.id) + 1}：${formatTime(draft.startUs)}${drag.current.snapped ? " 吸着中" : ""}`
            : `開始 ${formatTime(draft.startUs)} ／ 終了 ${formatTime(draft.endUs)} ／ 長さ ${formatTime(draft.endUs - draft.startUs)}${drag.current?.snapped ? " 吸着中" : ""}`
          : ""}
      </output>
      <div
        ref={viewport}
        data-testid="video-timeline"
        tabIndex={0}
        aria-label="動画タイムライン操作"
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const time = media?.()?.currentTime;
          const current = time === undefined ? currentUs : time * 1e6;
          let target: number;
          if (event.key === "ArrowLeft" || event.key === "ArrowRight")
            target =
              current +
              (event.key === "ArrowLeft" ? -1 : 1) *
                frameTimeUs(event.shiftKey ? 10 : 1);
          else if (event.key === "Home") target = bounds?.startUs ?? minTime;
          else if (event.key === "End") target = bounds?.endUs ?? maxTime;
          else return;
          event.preventDefault();
          manualUntil.current = 0;
          onSeek(
            Math.round(
              clamp(
                target,
                bounds?.startUs ?? minTime,
                bounds?.endUs ?? maxTime,
              ),
            ),
          );
        }}
        style={{
          position: "relative",
          height: mode === "fnf" ? 300 : 180,
          overflow: "auto",
          touchAction: "none",
          overscrollBehaviorX: "none",
          border: "1px solid #718096",
          background: "#211e27",
        }}
        onWheel={() => {
          manualUntil.current = Infinity;
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={(e) => clear(e.currentTarget)}
        onLostPointerCapture={(e) => {
          if (e.target === e.currentTarget && points.current.has(e.pointerId))
            clear(e.currentTarget);
        }}
        onScroll={(e) => {
          const x = e.currentTarget.scrollLeft;
          if (head.current) head.current.style.left = `${x + width / 2}px`;
          if (!bounds || performance.now() - lastScrollPublish.current > 80) {
            setScroll(x);
            lastScrollPublish.current = performance.now();
          }
          if (
            autoScroll.current !== null &&
            Math.abs(x - autoScroll.current) < 1
          ) {
            autoScroll.current = null;
            return;
          }
          if (bounds) manualUntil.current = Infinity;
          if (
            !pinch.current &&
            drag.current?.kind !== "start" &&
            drag.current?.kind !== "end" &&
            drag.current?.kind !== "marker"
          )
            onSeek(centerTime(origin, x, pps, minTime, maxTime));
          if (
            (x <= 0 || x >= trackWidth - width - 1) &&
            spanUs < maxTime - minTime &&
            !points.current.size
          ) {
            const center =
                origin + ((x + width / 2 - padding) / pps) * 1_000_000,
              newOrigin = clamp(center - spanUs / 2, minTime, maxTime - spanUs);
            if (newOrigin !== origin) {
              pendingScroll.current =
                ((center - newOrigin) / 1_000_000) * pps + padding - width / 2;
              setOrigin(newOrigin);
            }
          }
        }}
      >
        <div
          style={{
            width: trackWidth,
            position: "relative",
            height:
              mode === "fnf" ? Math.max(240, display.length * 148 + 60) : 170,
          }}
        >
          <div style={{ height: 60 }} />
          {Array.from(
            { length: tickCount },
            (_, i) => (firstTick + i) * tickSeconds * 1e6,
          )
            .filter((t) => t <= maxTime)
            .map((time) => (
              <span
                key={time}
                style={{
                  position: "absolute",
                  left: padding + ((time - origin) / 1e6) * pps,
                  top: 8,
                  fontSize: 10,
                  borderLeft: "1px solid #aaa",
                  paddingLeft: 3,
                  pointerEvents: "none",
                }}
              >
                {formatTime(Math.round(time))}
              </span>
            ))}
          {display.map((item, index) => {
            if (
              (item.endUs < origin || item.startUs > origin + spanUs) &&
              drag.current?.id !== item.id
            )
              return null;
            const left = padding + ((item.startUs - origin) / 1_000_000) * pps,
              right = padding + ((item.endUs - origin) / 1_000_000) * pps,
              top = 60 + (mode === "fnf" ? index * 148 : 0),
              laneLeft = Math.max(padding, left),
              laneRight = Math.min(right, padding + (spanUs / 1_000_000) * pps),
              visibleLeft = Math.max(laneLeft, scroll - width / 2),
              visibleRight = Math.min(laneRight, scroll + width * 1.5);
            return (
              <div key={item.id}>
                <div
                  style={{
                    position: "absolute",
                    left: clamp(
                      left,
                      padding,
                      padding + (spanUs / 1_000_000) * pps,
                    ),
                    top,
                    width: Math.max(
                      2,
                      Math.min(right, padding + (spanUs / 1_000_000) * pps) -
                        Math.max(padding, left),
                    ),
                    height: 88,
                    background: "#895e9f",
                    borderTop: "3px solid #f5f1f7",
                    borderBottom: "3px solid #f5f1f7",
                    boxSizing: "border-box",
                    overflow: "hidden",
                    pointerEvents: "none",
                  }}
                >
                  {visibleRight > visibleLeft && (
                    <LaneWaveform
                      gain={gain}
                      waveform={waveform}
                      startUs={
                        origin + ((visibleLeft - padding) / pps) * 1_000_000
                      }
                      endUs={
                        origin + ((visibleRight - padding) / pps) * 1_000_000
                      }
                      width={visibleRight - visibleLeft}
                      left={visibleLeft - laneLeft}
                    />
                  )}
                  <span
                    style={{
                      position: "relative",
                      zIndex: 1,
                      padding: "2px 6px",
                      fontSize: 12,
                      color: "white",
                      background: "#493357b3",
                    }}
                  >
                    {item.label}
                  </span>
                </div>
                {(["start", "end"] as const)
                  .filter((edge) => {
                    const x = edge === "start" ? left : right;
                    // Never let a marker outside the virtual track enlarge scrollWidth.
                    // Half-viewport padding still permits re-expanding a trimmed edge.
                    return x >= 22 && x <= trackWidth - 22;
                  })
                  .map((edge) => (
                    <button
                      key={edge}
                      type="button"
                      data-action={edge}
                      data-id={item.id}
                      aria-label={`${item.label} ${edge === "start" ? "開始" : "終了"}handle`}
                      onFocus={() => onBoundarySelect?.(`${item.id}:${edge}`)}
                      onClick={() => onBoundarySelect?.(`${item.id}:${edge}`)}
                      title={`${edge === "start" ? "開始" : "終了"}位置をドラッグして調整`}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "ArrowLeft" &&
                          event.key !== "ArrowRight"
                        )
                          return;
                        event.preventDefault();
                        const delta =
                          (event.key === "ArrowLeft" ? -1 : 1) *
                          frameTimeUs(event.shiftKey ? 10 : 1);
                        const limits = trimEdgeLimits(
                          item,
                          durationUs,
                          frameTimeUs(1),
                          mode === "all-versions" && onMarkerEdit
                            ? markers
                            : [],
                        );
                        const start =
                          edge === "start"
                            ? clamp(
                                item.startUs + delta,
                                limits.startMin,
                                limits.startMax,
                              )
                            : item.startUs;
                        const end =
                          edge === "end"
                            ? clamp(
                                item.endUs + delta,
                                limits.endMin,
                                limits.endMax,
                              )
                            : item.endUs;
                        onEdit(item.id, Math.round(start), Math.round(end));
                      }}
                      style={{
                        position: "absolute",
                        // Marker geometry must use source time, never viewport clamping.
                        left: (edge === "start" ? left : right) - 22,
                        // Separate hit regions when a short range projects to <44px.
                        top:
                          top + (right - left < 44 && edge === "end" ? 44 : 0),
                        width: 44,
                        height: right - left < 44 ? 44 : 88,
                        minWidth: 44,
                        padding: 0,
                        border:
                          selectedBoundary === `${item.id}:${edge}`
                            ? "2px solid white"
                            : 0,
                        borderRadius: 8,
                        background: "transparent",
                        color: edge === "start" ? "#123b2e" : "#512421",
                        cursor: "ew-resize",
                        touchAction: "none",
                        userSelect: "none",
                        zIndex:
                          drag.current?.id === item.id &&
                          drag.current.kind === edge
                            ? 6
                            : 5,
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          position: "absolute",
                          inset: "0 12px",
                          borderRadius: 6,
                          background: edge === "start" ? "#91f0c2" : "#ffb4a8",
                          display: "grid",
                          placeItems: "center",
                          boxShadow: "0 1px 4px #0004",
                        }}
                      >
                        {edge === "start" ? "始" : "終"}
                      </span>
                    </button>
                  ))}
                {editing && mode === "fnf" && (
                  <button
                    data-action="move"
                    data-id={item.id}
                    aria-label={`${item.label} 全体移動`}
                    style={{
                      position: "absolute",
                      left: clamp(
                        left,
                        padding,
                        padding + (spanUs / 1_000_000) * pps,
                      ),
                      top: top + 92,
                      minWidth: 44,
                      minHeight: 44,
                      width: Math.max(
                        44,
                        Math.min(right, padding + (spanUs / 1_000_000) * pps) -
                          Math.max(padding, left),
                      ),
                    }}
                  >
                    全体移動
                  </button>
                )}
              </div>
            );
          })}
          {candidates
            .filter((c) => c.endUs >= origin && c.startUs <= origin + spanUs)
            .map((c) => (
              <div
                key={c.id}
                title={`${formatTime(c.timeUs)} ${c.confidence}`}
                style={{
                  position: "absolute",
                  pointerEvents: "none",
                  left:
                    padding +
                    ((Math.max(origin, c.startUs) - origin) / 1e6) * pps,
                  width: Math.max(
                    2,
                    ((Math.min(origin + spanUs, c.endUs) -
                      Math.max(origin, c.startUs)) /
                      1e6) *
                      pps,
                  ),
                  top: 35,
                  height: 125,
                  background: "#42c9cf30",
                  zIndex: 2,
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    left:
                      ((c.timeUs - Math.max(origin, c.startUs)) / 1e6) * pps,
                    color: "#60efff",
                  }}
                >
                  ◆
                </span>
              </div>
            ))}
          {markers
            .map((m, i) => ({ m, i }))
            .filter(({ m }) => m >= origin && m <= origin + spanUs)
            .map(({ m, i }) => (
              <button
                type="button"
                key={`${m}:${i}`}
                title={formatTime(m)}
                data-action={onMarkerEdit ? "marker" : undefined}
                data-index={i}
                data-time={m}
                role={onMarkerEdit ? "slider" : undefined}
                onFocus={() => onBoundarySelect?.(`marker:${i}`)}
                onClick={() => onBoundarySelect?.(`marker:${i}`)}
                aria-label={`Version境界 ${i + 1}`}
                aria-valuenow={m / 1e6}
                aria-valuemin={minTime / 1e6}
                aria-valuemax={maxTime / 1e6}
                tabIndex={onMarkerEdit ? 0 : undefined}
                onKeyDown={(event) => {
                  if (
                    !onMarkerEdit ||
                    !["ArrowLeft", "ArrowRight"].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  const index = markers.indexOf(m);
                  const target =
                    m + (event.key === "ArrowLeft" ? -1 : 1) * frameTimeUs(1);
                  const lower =
                    markers[index - 1] ?? items[0]?.startUs ?? minTime;
                  const upper =
                    markers[index + 1] ?? items.at(-1)?.endUs ?? maxTime;
                  if (target > lower && target < upper)
                    onMarkerEdit(index, Math.round(target));
                }}
                style={{
                  position: "absolute",
                  left:
                    padding +
                    (((drag.current?.kind === "marker" &&
                    Number(draft?.id) === markers.indexOf(m)
                      ? draft!.startUs
                      : m) -
                      origin) /
                      1_000_000) *
                      pps -
                    22,
                  width: 44,
                  top: 0,
                  height: 160,
                  padding: 0,
                  border:
                    selectedBoundary === `marker:${i}` ? "2px solid #fff" : 0,
                  color: "#f7bb54",
                  touchAction: "none",
                  background:
                    "linear-gradient(to right, transparent 21px, #f7bb54 21px, #f7bb54 23px, transparent 23px)",
                  pointerEvents: onMarkerEdit ? "auto" : "none",
                  zIndex: 3,
                }}
              >
                ↔
              </button>
            ))}
          <div
            ref={head}
            data-testid="timeline-head"
            style={{
              position: "absolute",
              left: scroll + width / 2,
              top: 0,
              height:
                mode === "fnf" ? Math.max(240, items.length * 148 + 60) : 170,
              borderLeft: "2px solid white",
              zIndex: 4,
              pointerEvents: "none",
            }}
          />
        </div>
      </div>
    </section>
  );
}
