import { expect, it } from "vitest";
import { PeakAccumulator } from "../../../src/services/video/local-waveform";
it("maps source timestamps and channels without losing anti-phase audio or silence", () => {
  const peaks = new PeakAccumulator(10);
  peaks.add(
    [new Float32Array([0.5, -0.8]), new Float32Array([-0.9, 0.3])],
    50,
    4,
  );
  expect(peaks.peaks.slice(400, 404)).toEqual([
    expect.closeTo(-0.9),
    0.5,
    expect.closeTo(-0.8),
    expect.closeTo(0.3),
  ]);
  expect(peaks.peaks.slice(0, 4)).toEqual([0, 0, 0, 0]);
});
it("bounds long-file peak storage and clips negative timestamps and overlaps", () => {
  const peaks = new PeakAccumulator(10 * 3600);
  expect(peaks.peaks.length).toBeLessThanOrEqual(40002);
  const short = new PeakAccumulator(2);
  short.add([new Float32Array([1, 0.5, 0.2])], 50, -0.02, 0.02);
  expect(short.peaks.slice(0, 4)).toEqual([0, 0, 0, expect.closeTo(0.2)]);
});
