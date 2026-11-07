/** Geometry is in CSS pixels, editing values in integer microseconds. */
export function centerTime(
  origin: number,
  scroll: number,
  pps: number,
  min: number,
  max: number,
) {
  return Math.round(
    Math.min(max, Math.max(min, origin + (scroll / pps) * 1e6)),
  );
}
/** Hysteresis makes a deliberate pull release the marker at every zoom level. */
export function snapMarker(
  value: number,
  center: number,
  pps: number,
  latched: boolean,
) {
  const snapped = (Math.abs(value - center) / 1e6) * pps <= (latched ? 18 : 10);
  return { value: snapped ? center : value, snapped };
}
export function waveformHeight(amplitude: number, gain = 1) {
  // IEEE decoded +0/-0 alone are silent. No epsilon gate or minimum bar height.
  return amplitude === 0 ? 0 : Math.min(1, Math.abs(amplitude) * gain) * 60;
}

/** 1/2/5 scale steps keep full microsecond time labels legible at every zoom. */
export function tickInterval(pps: number, spacing = 120) {
  const base = 10 ** Math.floor(Math.log10(spacing / pps));
  return [1, 2, 5, 10]
    .map((value) => value * base)
    .find((step) => step * pps >= spacing)!;
}

/** Keep trim edges ordered around existing Version boundaries (integer µs). */
export function trimEdgeLimits(
  item: { startUs: number; endUs: number; minUs?: number; maxUs?: number },
  durationUs: number,
  minimumUs: number,
  markers: number[],
) {
  const inside = markers.filter((m) => m > item.startUs && m < item.endUs);
  return {
    startMin: item.minUs ?? 0,
    startMax: Math.min(item.endUs - minimumUs, ...inside.map((m) => m - 1)),
    endMin: Math.max(item.startUs + minimumUs, ...inside.map((m) => m + 1)),
    endMax: item.maxUs ?? durationUs,
  };
}

/** Nearest editable marker within 10 CSS pixels, capped at 120ms when zoomed out. */
export function nearestBoundary(
  markers: number[],
  currentUs: number,
  pps: number,
) {
  const tolerance = Math.min(120_000, (10 / pps) * 1e6);
  let index = -1;
  let distance = Infinity;
  markers.forEach((marker, i) => {
    const delta = Math.abs(marker - currentUs);
    if (delta <= tolerance && delta < distance) {
      index = i;
      distance = delta;
    }
  });
  return index;
}

/** Native decoders seek to duration - 1us at EOF. That sample is the closed
 * out-point in the editor, not a useful new Version interval. */
export function isInteriorBoundary(us: number, startUs: number, endUs: number) {
  const time = Math.round(us);
  return Number.isFinite(time) && time > startUs + 1 && time < endUs - 1;
}
