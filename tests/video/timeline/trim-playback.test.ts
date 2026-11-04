import { expect, it, vi } from "vitest";
import {
  trimRanges,
  clampToTrim,
  bindTrimPlayback,
} from "../../../src/services/video/trim-playback";
it("normalizes disjoint source ranges and clamps seeks without changing the source time axis", () => {
  const ranges = trimRanges(
    [
      { start: 120, end: 200 },
      { start: 300, end: 480 },
    ],
    600,
  );
  expect(clampToTrim(0, ranges)).toBe(120);
  expect(clampToTrim(600, ranges)).toBe(480);
  expect(clampToTrim(310, ranges)).toBe(310);
  expect(clampToTrim(220, ranges)).toBe(200);
  expect(
    trimRanges(
      [
        { start: 120, end: 200 },
        { start: 150, end: 300 },
      ],
      250,
    ),
  ).toEqual([{ start: 120, end: 250 }]);
});
it("retains tiny nonzero amplitudes in high-resolution source windows", async () => {
  const { PeakAccumulator } =
    await import("../../../src/services/video/local-waveform");
  const accumulator = new PeakAccumulator(1, 1 / 48000);
  accumulator.add([new Float32Array([0, 0.000001, -0.5])], 48000, 0.25);
  expect(accumulator.step).toBeLessThan(0.001);
  expect(accumulator.peaks.some((p) => p > 0 && p < 0.00001)).toBe(true);
  expect(accumulator.peaks.some((p) => p === -0.5)).toBe(true);
  expect(accumulator.peaks.length).toBeLessThanOrEqual(40002);
});

it("does not repeatedly seek to an already reached end boundary", () => {
  vi.stubGlobal("cancelAnimationFrame", () => {});
  try {
    const target = new EventTarget();
    let time = 6,
      writes = 0;
    Object.defineProperties(target, {
      currentTime: {
        get: () => time,
        set: (value: number) => {
          time = value;
          writes++;
        },
      },
      paused: { value: true },
      loop: { value: false },
      readyState: { value: 1 },
      pause: { value: () => {} },
    });
    const release = bindTrimPlayback(target as HTMLVideoElement, [
      { start: 2, end: 6 },
    ]);
    target.dispatchEvent(new Event("timeupdate"));
    target.dispatchEvent(new Event("timeupdate"));
    expect(writes).toBe(0);
    time = 6.01;
    target.dispatchEvent(new Event("timeupdate"));
    expect(time).toBe(6);
    expect(writes).toBe(1);
    release();
  } finally {
    vi.unstubAllGlobals();
  }
});
