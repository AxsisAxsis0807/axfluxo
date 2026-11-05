import { expect, it } from "vitest";
import {
  centerTime,
  snapMarker,
  waveformHeight,
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
