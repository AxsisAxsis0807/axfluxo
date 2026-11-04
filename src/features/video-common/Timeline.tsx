"use client";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import type { Waveform } from "../../domain/video/preview";
import { formatTime, frameTimeUs } from "../../services/video/time";
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
}: {
  waveform?: TimelineWaveform;
  startUs: number;
  endUs: number;
  width: number;
  left: number;
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
    const level =
      waveform?.levels.find((level) => level.stepUs >= stepUs) ??
      waveform?.levels[0];
    if (!level) return;
    ctx.fillStyle = "#b899c9";
    // Aggregate every peak covered by a bar so short transients survive zooming out.
    for (let x = 0; x < width; x += 8) {
      const start = Math.max(
        startUs + x * stepUs,
        waveform?.clipStartUs ?? -Infinity,
      );
      const end = Math.min(
        startUs + (x + 8) * stepUs,
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
      const height = Math.max(2, Math.min(1, amplitude) * 60);
      ctx.fillRect(x, (88 - height) / 2, Math.min(5, width - x), height);
    }
  }, [waveform, startUs, endUs, width]);
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
}: {
  mode: "all-versions" | "fnf";
  durationUs: number;
  currentUs: number;
  items: TimelineItem[];
  markers: number[];
  onSeek: (us: number) => void;
  onEdit: (id: string, startUs: number, endUs: number) => void;
  waveform?: TimelineWaveform;
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
  const [zoom, setZoom] = useState(80),
    [origin, setOrigin] = useState(0),
    [scroll, setScroll] = useState(0),
    [width, setWidth] = useState(600),
    [draft, setDraft] = useState<TimelineItem | null>(null);
  const pps = zoom,
    spanUs = Math.min(durationUs, (8_000_000 / pps) * 1_000_000),
    padding = mode === "all-versions" ? width / 2 : 0,
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
    const node = viewport.current;
    if (!node) return;
    if (pendingScroll.current !== null) {
      node.scrollLeft = pendingScroll.current;
      autoScroll.current = node.scrollLeft;
      pendingScroll.current = null;
      return;
    }
    if (points.current.size) return;
    if (currentUs < origin || currentUs > origin + spanUs) {
      setOrigin(
        clamp(currentUs - spanUs / 2, 0, Math.max(0, durationUs - spanUs)),
      );
      return;
    }
    if (mode === "all-versions") {
      const target = ((currentUs - origin) / 1_000_000) * pps;
      autoScroll.current = target;
      node.scrollLeft = target;
    }
  }, [currentUs, origin, spanUs, durationUs, pps, mode, padding]);
  function changeZoom(next: number, anchorX = width / 2) {
    const node = viewport.current;
    if (!node) return;
    if (mode === "all-versions") anchorX = width / 2;
    const anchorUs =
        origin + ((node.scrollLeft + anchorX - padding) / pps) * 1_000_000,
      newZoom = clamp(next, 0.2, 8000),
      newSpan = Math.min(durationUs, (8_000_000 / newZoom) * 1_000_000),
      newOrigin = clamp(
        anchorUs - newSpan / 2,
        0,
        Math.max(0, durationUs - newSpan),
      );
    pendingScroll.current =
      ((anchorUs - newOrigin) / 1_000_000) * newZoom + padding - anchorX;
    setOrigin(newOrigin);
    setZoom(newZoom);
  }
  function down(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const node = event.currentTarget;
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
      const [a, b] = Array.from(points.current.values()),
        mid = (a.x + b.x) / 2 - node.getBoundingClientRect().left;
      pinch.current = {
        distance: Math.max(1, Math.abs(a.x - b.x)),
        zoom,
        anchor: mid,
      };
      return;
    }
    if (points.current.size !== 1) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-action]",
      ),
      item = items.find((i) => i.id === target?.dataset.id);
    drag.current = {
      kind: target?.dataset.action ?? "pan",
      id: item?.id ?? "",
      startX: event.clientX,
      startY: event.clientY,
      scroll: node.scrollLeft,
      scrollY: node.scrollTop,
      original: item ?? { id: "", startUs: 0, endUs: 0, label: "" },
      delta: 0,
    };
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!points.current.has(event.pointerId)) return;
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && points.current.size >= 2) {
      const [a, b] = Array.from(points.current.values());
      changeZoom(
        (pinch.current.zoom * Math.max(1, Math.abs(a.x - b.x))) /
          pinch.current.distance,
        (a.x + b.x) / 2 - event.currentTarget.getBoundingClientRect().left,
      );
      return;
    }
    const d = drag.current;
    if (!d) return;
    d.delta = event.clientX - d.startX;
    if (d.kind === "pan") {
      event.currentTarget.scrollLeft = d.scroll - d.delta;
      event.currentTarget.scrollTop = d.scrollY - (event.clientY - d.startY);
      return;
    }
    const deltaFrames = Math.round((d.delta / pps) * 60),
      delta = Math.sign(deltaFrames) * frameTimeUs(Math.abs(deltaFrames)),
      base = d.original,
      min = base.minUs ?? 0,
      max = base.maxUs ?? durationUs;
    let start = base.startUs,
      end = base.endUs;
    if (d.kind === "start")
      start = clamp(start + delta, min, end - frameTimeUs(1));
    if (d.kind === "end") end = clamp(end + delta, start + frameTimeUs(1), max);
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
      if (!points.current.size) clear(event.currentTarget);
      return;
    }
    if (d && finalDraft) {
      onEdit(d.id, finalDraft.startUs, finalDraft.endUs);
    } else if (d?.kind === "pan" && Math.abs(d.delta) < 4) {
      const x =
        event.clientX - event.currentTarget.getBoundingClientRect().left;
      onSeek(
        Math.round(
          clamp(
            origin +
              ((event.currentTarget.scrollLeft + x - padding) / pps) *
                1_000_000,
            0,
            durationUs,
          ),
        ),
      );
    }
    clear(event.currentTarget);
  }
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
      <p style={{ fontSize: 12 }}>
        左右のツマミをドラッグして切り取り範囲を調整
      </p>
      <output aria-live="polite" style={{ fontSize: 12 }}>
        {draft
          ? `開始 ${formatTime(draft.startUs)} ／ 終了 ${formatTime(draft.endUs)} ／ 長さ ${formatTime(draft.endUs - draft.startUs)}`
          : ""}
      </output>
      <div
        ref={viewport}
        data-testid="video-timeline"
        style={{
          position: "relative",
          height: mode === "fnf" ? 300 : 180,
          overflow: "auto",
          touchAction: "none",
          border: "1px solid #718096",
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
          setScroll(x);
          if (
            autoScroll.current !== null &&
            Math.abs(x - autoScroll.current) < 1
          ) {
            autoScroll.current = null;
            return;
          }
          if (mode === "all-versions" && !pinch.current)
            onSeek(
              Math.round(clamp(origin + (x / pps) * 1_000_000, 0, durationUs)),
            );
          if (
            (x <= 0 || x >= trackWidth - width - 1) &&
            spanUs < durationUs &&
            !points.current.size
          ) {
            const center =
                origin + ((x + width / 2 - padding) / pps) * 1_000_000,
              newOrigin = clamp(center - spanUs / 2, 0, durationUs - spanUs);
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
          {display.map((item, index) => {
            if (item.endUs < origin || item.startUs > origin + spanUs)
              return null;
            const left = padding + ((item.startUs - origin) / 1_000_000) * pps,
              right = padding + ((item.endUs - origin) / 1_000_000) * pps,
              top = 60 + (mode === "fnf" ? index * 148 : 0),
              laneLeft = Math.max(padding, left),
              laneRight = Math.min(right, padding + (spanUs / 1_000_000) * pps),
              visibleLeft = Math.max(laneLeft, scroll),
              visibleRight = Math.min(laneRight, scroll + width);
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
                {(["start", "end"] as const).map((edge) => (
                  <button
                    key={edge}
                    type="button"
                    data-action={edge}
                    data-id={item.id}
                    aria-label={`${item.label} ${edge === "start" ? "開始" : "終了"}handle`}
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
                      const start =
                        edge === "start"
                          ? clamp(
                              item.startUs + delta,
                              item.minUs ?? 0,
                              item.endUs - frameTimeUs(1),
                            )
                          : item.startUs;
                      const end =
                        edge === "end"
                          ? clamp(
                              item.endUs + delta,
                              item.startUs + frameTimeUs(1),
                              item.maxUs ?? durationUs,
                            )
                          : item.endUs;
                      onEdit(item.id, Math.round(start), Math.round(end));
                    }}
                    style={{
                      position: "absolute",
                      left: (edge === "start" ? laneLeft : laneRight) - 22,
                      top,
                      width: 44,
                      height: 88,
                      minWidth: 44,
                      padding: 0,
                      border: 0,
                      borderRadius: 8,
                      background: "transparent",
                      color: "#513361",
                      cursor: "ew-resize",
                      touchAction: "none",
                      userSelect: "none",
                      zIndex:
                        drag.current?.id === item.id &&
                        drag.current.kind === edge
                          ? 4
                          : 2,
                      visibility: (
                        edge === "start"
                          ? item.startUs < origin
                          : item.endUs > origin + spanUs
                      )
                        ? "hidden"
                        : "visible",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        inset: "0 12px",
                        borderRadius: 6,
                        background: "#f5f1f7",
                        display: "grid",
                        placeItems: "center",
                        boxShadow: "0 1px 4px #0004",
                      }}
                    >
                      <span
                        style={{
                          width: 3,
                          height: 28,
                          borderRadius: 2,
                          background: "currentColor",
                        }}
                      />
                    </span>
                  </button>
                ))}
                {mode === "fnf" && (
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
          {markers
            .filter((m) => m >= origin && m <= origin + spanUs)
            .map((m, i) => (
              <div
                key={`${m}:${i}`}
                title={formatTime(m)}
                style={{
                  position: "absolute",
                  left: padding + ((m - origin) / 1_000_000) * pps,
                  top: 0,
                  height: 160,
                  borderLeft: "2px solid #f7bb54",
                  pointerEvents: "none",
                }}
              />
            ))}
          <div
            data-testid="timeline-head"
            style={{
              position: "absolute",
              left:
                mode === "all-versions"
                  ? scroll + width / 2
                  : padding + ((currentUs - origin) / 1_000_000) * pps,
              top: 0,
              height:
                mode === "fnf" ? Math.max(240, items.length * 148 + 60) : 170,
              borderLeft: "2px solid white",
              pointerEvents: "none",
            }}
          />
        </div>
      </div>
    </section>
  );
}
