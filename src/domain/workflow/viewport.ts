import { WORKFLOW_LIMITS } from "../../config/workflow-limits";
import type { Viewport } from "./schema";
export type Point = { x: number; y: number };
export function pinchViewport(
  start: Viewport,
  from: [Point, Point],
  to: [Point, Point],
): Viewport {
  const distance = (p: [Point, Point]) =>
    Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  const midpoint = (p: [Point, Point]) => ({
    x: (p[0].x + p[1].x) / 2,
    y: (p[0].y + p[1].y) / 2,
  });
  const initial = midpoint(from),
    next = midpoint(to),
    length = distance(from);
  const zoom = Math.max(
    WORKFLOW_LIMITS.minZoom,
    Math.min(
      WORKFLOW_LIMITS.maxZoom,
      length ? (start.zoom * distance(to)) / length : start.zoom,
    ),
  );
  return {
    x: next.x - ((initial.x - start.x) * zoom) / start.zoom,
    y: next.y - ((initial.y - start.y) * zoom) / start.zoom,
    zoom,
  };
}
