import { expect, it } from "vitest";
import {
  centerTime,
  snapMarker,
  waveformHeight,
  tickInterval,
} from "../../../src/services/video/timeline-math";
import { PeakAccumulator } from "../../../src/services/video/local-waveform";
it("renders no height at exact zero and preserves every nonzero decoded value without a floor", () => {
  expect(waveformHeight(0, 1000)).toBe(0);
  expect(waveformHeight(-0, 1000)).toBe(0);
  expect(waveformHeight(1e-12)).toBeGreaterThan(0);
  expect(waveformHeight(1e-9, 10)).toBeCloseTo(waveformHeight(1e-9) * 10, 15);
  const p = new PeakAccumulator(1, 0.01);
  p.add([new Float32Array([0, 1e-12, 0])], 100, 0);
  expect(p.peaks[3]).toBeGreaterThan(0);
  expect(p.peaks[0]).toBe(0);
  expect(p.peaks[5]).toBe(0);
});
it("preserves the center through zoom and clamps endpoints without treating padding as audio", () => {
  for (const zoom of [0.2, 80, 8000, 192000]) {
    expect(centerTime(0, 0, zoom, 0, 10e6)).toBe(0);
    expect(centerTime(0, 10 * zoom, zoom, 0, 10e6)).toBe(10e6);
    expect(centerTime(0, 3.456789 * zoom, zoom, 0, 10e6)).toBe(3456789);
    expect(centerTime(0, -100, zoom, 0, 10e6)).toBe(0);
  }
});
it("uses CSS pixel snap distance with release hysteresis and adopts the precise central time", () => {
  for (const zoom of [1, 80, 192000]) {
    const center = 3e6;
    expect(snapMarker(center + (9 / zoom) * 1e6, center, zoom, false)).toEqual({
      value: center,
      snapped: true,
    });
    expect(
      snapMarker(center + (15 / zoom) * 1e6, center, zoom, true).snapped,
    ).toBe(true);
    expect(
      snapMarker(center + (20 / zoom) * 1e6, center, zoom, true).snapped,
    ).toBe(false);
  }
});
it("increases temporal information with finer analysis instead of stretching coarse peaks", () => {
  const samples = new Float32Array([0, 0.1, 0.9, 0]);
  const coarse = new PeakAccumulator(0.04, 0.04),
    fine = new PeakAccumulator(0.04, 0.01);
  coarse.add([samples], 100, 0);
  fine.add([samples], 100, 0);
  expect(coarse.peaks).toHaveLength(2);
  expect(fine.peaks).toHaveLength(8);
  expect(fine.peaks[1]).toBe(0);
  expect(fine.peaks[3]).toBeCloseTo(0.1);
  expect(fine.peaks[5]).toBeCloseTo(0.9);
});

it("keeps time labels spaced apart when zoom crosses a decimal scale boundary", () => {
  for (const pps of [0.2, 80, 100, 120, 8000, 192000]) {
    expect(tickInterval(pps) * pps).toBeGreaterThanOrEqual(120);
    expect(tickInterval(pps) * pps).toBeLessThanOrEqual(300);
  }
});

it("keeps trim edges around Version boundaries and within source endpoints", async () => {
  const { trimEdgeLimits } =
    await import("../../../src/services/video/timeline-math");
  const item = { startUs: 0, endUs: 8e6 };
  expect(trimEdgeLimits(item, 8e6, 16667, [2e6, 6e6])).toEqual({
    startMin: 0,
    startMax: 1999999,
    endMin: 6000001,
    endMax: 8e6,
  });
  expect(trimEdgeLimits(item, 8e6, 16667, [])).toEqual({
    startMin: 0,
    startMax: 7983333,
    endMin: 16667,
    endMax: 8e6,
  });
});

it("targets only the nearest Version marker with pixel tolerance and a time cap", async () => {
  const { nearestBoundary } =
    await import("../../../src/services/video/timeline-math");
  expect(nearestBoundary([1e6, 1.08e6, 2e6], 1.06e6, 80)).toBe(1);
  expect(nearestBoundary([1e6], 1.13e6, 0.2)).toBe(-1);
  expect(nearestBoundary([1e6], 1e6 + (9 / 8000) * 1e6, 8000)).toBe(0);
  expect(nearestBoundary([1e6], 1e6 + (11 / 8000) * 1e6, 8000)).toBe(-1);
  expect(nearestBoundary([], 0, 80)).toBe(-1);
});

it("does not turn a native EOF sample or sub-microsecond rounding into a Version", async () => {
  const { isInteriorBoundary } =
    await import("../../../src/services/video/timeline-math");
  for (const us of [0, 0.4, 1, 42e6, 42e6 - 1, 42e6 - 0.6])
    expect(isInteriorBoundary(us, 0, 42e6)).toBe(false);
  expect(isInteriorBoundary(20e6, 0, 42e6)).toBe(true);
  expect(isInteriorBoundary(2e6 + 1, 2e6, 40e6)).toBe(false);
  expect(isInteriorBoundary(40e6 - 1, 2e6, 40e6)).toBe(false);
});
