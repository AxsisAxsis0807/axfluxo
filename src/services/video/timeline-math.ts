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
