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
  waveform?: Waveform & { clipStartUs?: number; clipEndUs?: number };
}) {
  const viewport = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    points = useRef(new Map<number, { x: number; y: number }>()),
    drag = useRef<Drag | null>(null),
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
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(width * ratio);
    c.height = 60 * ratio;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, 60);
    ctx.strokeStyle = "#67c9d5";
    ctx.beginPath();
    const level =
      waveform?.levels.find((l) => l.stepUs >= 1_000_000 / pps) ??
      waveform?.levels[0];
    if (level)
      for (let x = 0; x < width; x++) {
        const time = origin + ((scroll + x - padding) / pps) * 1_000_000,
          index =
            Math.floor((time - (waveform?.originUs ?? 0)) / level.stepUs) * 2;
        if (
          waveform?.clipStartUs !== undefined &&
          (time < waveform.clipStartUs || time >= waveform.clipEndUs!)
        )
          continue;
        if (index >= 0 && index + 1 < level.peaks.length) {
          ctx.moveTo(x, 30 - level.peaks[index] * 25);
          ctx.lineTo(x, 30 - level.peaks[index + 1] * 25);
        }
      }
    ctx.stroke();
  }, [waveform, origin, scroll, padding, pps, width]);
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
    try {
      node.setPointerCapture(event.pointerId);
    } catch {
      /* Pointer may already have been cancelled by the browser. */
    }
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.current.size === 2) {
      drag.current = null;
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
    setDraft({ ...base, startUs: Math.round(start), endUs: Math.round(end) });
  }
  function clear(node: HTMLDivElement) {
    for (const id of points.current.keys())
      if (node.hasPointerCapture(id)) node.releasePointerCapture(id);
    points.current.clear();
    pinch.current = null;
    drag.current = null;
    setDraft(null);
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    const d = drag.current,
      isPinch = Boolean(pinch.current);
    points.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (isPinch) {
      if (!points.current.size) clear(event.currentTarget);
      return;
    }
    if (d && draft) {
      onEdit(d.id, draft.startUs, draft.endUs);
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
          if (points.current.has(e.pointerId)) clear(e.currentTarget);
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
          <canvas
            ref={canvas}
            aria-label="音声波形"
            style={{
              position: "sticky",
              left: 0,
              top: 0,
              width,
              height: 60,
              pointerEvents: "none",
            }}
          />
          {display.map((item, index) => {
            if (item.endUs < origin || item.startUs > origin + spanUs)
              return null;
            const left = padding + ((item.startUs - origin) / 1_000_000) * pps,
              right = padding + ((item.endUs - origin) / 1_000_000) * pps,
              top = 60 + (mode === "fnf" ? index * 148 : 0);
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
                    background: "#234253",
                    pointerEvents: "none",
                  }}
                >
                  {item.label}
                </div>
                <button
                  data-action="start"
                  data-id={item.id}
                  aria-label={`${item.label} 開始handle`}
                  style={{
                    position: "absolute",
                    left:
                      clamp(
                        left,
                        padding,
                        padding + (spanUs / 1_000_000) * pps,
                      ) - 22,
                    visibility: item.startUs < origin ? "hidden" : "visible",
                    top,
                    minWidth: 44,
                    minHeight: 44,
                  }}
                >
                  開始
                </button>
                <button
                  data-action="end"
                  data-id={item.id}
                  aria-label={`${item.label} 終了handle`}
                  style={{
                    position: "absolute",
                    left:
                      clamp(
                        right,
                        padding,
                        padding + (spanUs / 1_000_000) * pps,
                      ) - 22,
                    visibility:
                      item.endUs > origin + spanUs ? "hidden" : "visible",
                    top: top + 44,
                    minWidth: 44,
                    minHeight: 44,
                  }}
                >
                  終了
                </button>
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
