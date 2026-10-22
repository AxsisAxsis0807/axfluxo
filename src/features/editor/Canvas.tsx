"use client";
import { useEffect, useRef, useState } from "react";
import type { Layer, Page, ProjectDocument } from "../../domain/document";
import { createScene } from "../../renderers/scene";
import type Konva from "konva";
type Point = { x: number; y: number };
export default function Canvas({
  page,
  document: project,
  selected,
  onSelect,
  onPatch,
  zoom,
  onZoom,
  snap,
  panMode,
  fitToken,
}: {
  page: Page;
  document: ProjectDocument;
  selected?: string;
  onSelect: (id: string) => void;
  onPatch: (id: string, p: Partial<Layer>) => void;
  zoom: number;
  onZoom: (z: number) => void;
  snap: boolean;
  panMode: boolean;
  fitToken: number;
}) {
  const outer = useRef<HTMLDivElement>(null),
    container = useRef<HTMLDivElement>(null),
    stage = useRef<Konva.Stage | null>(null);
  const callbacks = useRef({ onSelect, onPatch, onZoom });
  callbacks.current = { onSelect, onPatch, onZoom };
  const [size, setSize] = useState({ width: 650, height: 650 }),
    [error, setError] = useState(""),
    [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const space = useRef(false),
    pointers = useRef(new Map<number, Point>()),
    gesture = useRef<{
      points: Point[];
      pan: Point;
      zoom: number;
      mode: "pan" | "pinch";
    } | null>(null),
    suppressMove = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (
        e.code === "Space" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target instanceof HTMLSelectElement)
      ) {
        e.preventDefault();
        space.current = true;
      }
    };
    const up = () => {
      space.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", up);
    };
  }, []);
  useEffect(() => {
    if (!outer.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(outer.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [page.id, fitToken]);
  const scale = Math.max(
    0.01,
    Math.min((size.width - 72) / page.width, (size.height - 72) / page.height) *
      zoom,
  );
  useEffect(() => {
    let cancelled = false;
    const host = container.current;
    if (!host) return;
    const el = window.document.createElement("div");
    host.appendChild(el);
    let owned: Konva.Stage | undefined;
    createScene(el, page, project, {
      scale,
      selected,
      snap,
      onSelect: (id) => {
        if (!suppressMove.current) callbacks.current.onSelect(id);
      },
      onMove: (id, x, y) => {
        if (!suppressMove.current) callbacks.current.onPatch(id, { x, y });
      },
      onTransform: (id, p) => callbacks.current.onPatch(id, p),
    })
      .then((result) => {
        owned = result.stage;
        if (cancelled) {
          owned.destroy();
          el.remove();
          return;
        }
        stage.current = owned;
        setError("");
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message));
      });
    return () => {
      cancelled = true;
      owned?.destroy();
      if (stage.current === owned) stage.current = null;
      el.remove();
    };
  }, [page, project, scale, selected, snap]);
  const distance = (p: Point[]) => Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
  const midpoint = (p: Point[]) => ({
    x: (p[0].x + p[1].x) / 2,
    y: (p[0].y + p[1].y) / 2,
  });
  const finish = (id: number) => {
    pointers.current.delete(id);
    if (!pointers.current.size) {
      gesture.current = null;
      suppressMove.current = false;
    }
  };
  return (
    <div
      className="canvas-area"
      ref={outer}
      style={{ touchAction: "none", cursor: panMode ? "grab" : undefined }}
      onPointerDownCapture={(e) => {
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const points = [...pointers.current.values()];
        if (points.length === 2 || panMode || space.current || e.button === 1) {
          suppressMove.current = true;
          stage.current?.find("Group").forEach((node) => node.stopDrag());
          gesture.current = {
            points,
            pan,
            zoom,
            mode: points.length === 2 ? "pinch" : "pan",
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      onPointerMoveCapture={(e) => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const g = gesture.current,
          points = [...pointers.current.values()];
        if (!g) return;
        e.stopPropagation();
        if (g.mode === "pinch" && points.length === 2) {
          const d = distance(g.points);
          if (d > 0)
            callbacks.current.onZoom(
              Math.max(0.25, Math.min(4, (g.zoom * distance(points)) / d)),
            );
          const a = midpoint(g.points),
            b = midpoint(points);
          setPan({ x: g.pan.x + b.x - a.x, y: g.pan.y + b.y - a.y });
        } else if (g.mode === "pan" && points.length === 1)
          setPan({
            x: g.pan.x + points[0].x - g.points[0].x,
            y: g.pan.y + points[0].y - g.points[0].y,
          });
      }}
      onPointerUpCapture={(e) => finish(e.pointerId)}
      onPointerCancel={(e) => {
        pointers.current.clear();
        finish(e.pointerId);
      }}
      onLostPointerCapture={(e) => finish(e.pointerId)}
    >
      <div className="canvas-grid" />
      <div
        className="artboard"
        ref={container}
        style={{
          width: page.width * scale,
          height: page.height * scale,
          transform: `translate(${pan.x}px,${pan.y}px)`,
        }}
      />
      {!page.layers.length && (
        <div className="canvas-hint">
          <span>ここから、つくりはじめよう</span>
          <small>画像・テキスト・図形を追加してください</small>
        </div>
      )}
      {error && (
        <p className="canvas-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
