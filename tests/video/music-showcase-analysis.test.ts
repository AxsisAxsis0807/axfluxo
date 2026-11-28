import { describe, expect, it } from "vitest";
import {
  SHOWCASE_SPECTRUM,
  showcaseAnalyzer,
} from "../../src/domain/video/music-showcase-analysis";
import {
  shortReferenceCoverReaction,
  shortReferenceOpacity,
} from "../../src/domain/video/all-versions-short-reference";

const rate = 48_000;
const tone = (hz: number, seconds = 0.6) =>
  Float32Array.from(
    { length: Math.round(seconds * rate) },
    (_, n) => 0.6 * Math.sin((2 * Math.PI * n * hz) / rate),
  );
const read = (values: Float32Array, right = values) => {
  const analysis = showcaseAnalyzer(values.length);
  analysis.add(values, right);
  return analysis.finish();
};
const center = (bar: number) =>
  20 * 500 ** ((bar + 0.5) / SHOWCASE_SPECTRUM.count);
const highest = (bars: Uint8Array) =>
  bars.reduce((best, v, i) => (v > bars[best] ? i : best), 0);

it("keeps audio-reactive exposure off the measured cover fades", () => {
  const at = (time: number) => shortReferenceCoverReaction(time, 37);
  expect([at(0), at(1.5), at(35.6), at(36.6), at(37)]).toEqual([0, 0, 0, 0, 0]);
  expect(at(2)).toBeGreaterThan(0);
  expect(at(2)).toBeLessThan(at(3));
  expect(at(4.2)).toBe(1);
  expect(at(35.2)).toBeCloseTo(0.5);
  expect(shortReferenceCoverReaction(0.2, 0.4)).toBeGreaterThan(0);
  expect(shortReferenceCoverReaction(0, 0)).toBe(0);
});

describe("music showcase", () => {
  it.each([50, 100, 250, 500, 1000, 3000, 8000])(
    "places a %s Hz stereo tone in its spectral region",
    (hz) => {
      const values = tone(hz);
      const features = read(
        values,
        values.map((v) => -v),
      );
      const sample = features.sample(0.4);
      const dominant = center(highest(sample.bars));
      expect(dominant / hz).toBeGreaterThan(0.67);
      expect(dominant / hz).toBeLessThan(1.42);
      expect(Math.max(...sample.bars)).toBeGreaterThan(90);
      expect(sample.bars[hz < 1000 ? 100 : 3]).toBeLessThan(10);
    },
  );

  it("leaves silence stable and retains precisely the requested interval across chunks", () => {
    const data = tone(800, 1);
    data.fill(0, 0, 12000);
    data.fill(0, 36000);
    const expected = read(data);
    const incremental = showcaseAnalyzer(data.length);
    for (let i = 0; i < data.length; i += 1439)
      incremental.add(data.subarray(i, i + 1439), data.subarray(i, i + 1439));
    expect(incremental.finish().frames).toEqual(expected.frames);
    expect(Array.from(expected.sample(0.1).bars).every((v) => v === 0)).toBe(
      true,
    );
    expect(expected.sample(0.1).glow).toBe(0);
    const levels = [0.23, 0.3, 0.55, 0.78, 0.95].map((t) =>
      Math.max(...expected.sample(t).bars),
    );
    expect(levels[1]).toBeGreaterThan(levels[0] + 30);
    expect(levels[2]).toBeGreaterThan(levels[1]);
    expect(levels[3]).toBeLessThan(levels[2]);
    expect(levels[4]).toBeLessThan(levels[3]);
    const transient = expected.sample(0.3);
    expect(transient.exposure).not.toBe(expected.sample(0.1).exposure);
    expect(transient.glow).toBeGreaterThan(expected.sample(0.1).glow);
    expect(expected.sample(0.55)).toEqual(expected.sample(0.55));
  });

  it("rejects truncated or excessive feature allocations", () => {
    expect(() => showcaseAnalyzer(48000).finish()).toThrow("終端");
    expect(() => showcaseAnalyzer(2 ** 31)).toThrow("メモリ");
  });

  it("retains distinct layers in the tail without carrying the reference snap into new clips", () => {
    const duration = 37;
    const tail = shortReferenceOpacity(36.5, duration, true);
    expect(tail.cover).toBeCloseTo(0.23);
    expect(tail.title).toBeCloseTo(0.265);
    expect(tail.clock).toBeCloseTo(0.63);
    expect(shortReferenceOpacity(0, duration, true).title).toBe(1);
    expect(shortReferenceOpacity(duration, duration, true)).toEqual({
      cover: 0,
      title: 0,
      clock: 0,
    });
    const change = (responsive: boolean) =>
      shortReferenceOpacity(1.9, duration, responsive).cover -
      shortReferenceOpacity(1.85, duration, responsive).cover;
    expect(change(true)).toBeLessThan(change(false) / 2);
  });
});

it("tracks an ascending sweep and retains a bounded transient rather than a persistent flash", () => {
  const length = 2 * rate,
    initial = 20,
    span = Math.log(12000 / initial);
  const sweep = Float32Array.from({ length }, (_, n) => {
    const t = n / length;
    const phase = (2 * Math.PI * initial * 2 * Math.expm1(span * t)) / span;
    return 0.4 * Math.sin(phase);
  });
  const view = read(sweep);
  const dominant = [0.4, 0.9, 1.4, 1.8].map((t) =>
    center(highest(view.sample(t).bars)),
  );
  expect(
    dominant.every((hz, i) => i === 0 || hz > dominant[i - 1] * 1.35),
  ).toBe(true);
  const impulse = new Float32Array(rate);
  impulse[rate / 3] = 1;
  const transient = read(impulse);
  expect(transient.sample(0.37).glow).toBeGreaterThan(0);
  expect(transient.sample(1).glow).toBeLessThan(transient.sample(0.37).glow);
});

it("distinguishes band-limited, white, and pink noise without numerical instability", () => {
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 2 ** 32) * 2 - 1;
  };
  const seedValues = Float32Array.from({ length: rate }, () => random() * 0.4);
  let state = [0, 0, 0];
  const pink = seedValues.map((v) => {
    state = [
      0.997 * state[0] + v * 0.06,
      0.95 * state[1] + v * 0.22,
      0.62 * state[2] + v * 0.44,
    ];
    return 0.3 * (v * 0.08 + state.reduce((a, b) => a + b, 0));
  });
  function band(min: number, max: number) {
    const tones = Array.from({ length: 32 }, () => [
      min + ((random() + 1) / 2) * (max - min),
      random() * Math.PI,
    ]);
    return seedValues.map(
      (_value, i) =>
        0.036 *
        tones.reduce(
          (sum, [hz, phase]) =>
            sum + Math.sin(((2 * Math.PI * i) / rate) * hz + phase),
          0,
        ),
    );
  }
  for (const data of [seedValues, pink]) {
    const sample = read(data).sample(0.75);
    expect(sample.bars.filter((v) => v > 50).length).toBeGreaterThan(50);
    expect(sample.exposure).toBeGreaterThanOrEqual(0.86);
    expect(sample.exposure).toBeLessThanOrEqual(1.14);
  }
  for (const [low, high] of [
    [75, 220],
    [550, 1200],
    [4500, 7200],
  ]) {
    const view = read(band(low, high));
    const bars = view.sample(0.75).bars;
    const hot = center(highest(bars));
    expect(hot).toBeGreaterThan(low * 0.7);
    expect(hot).toBeLessThan(high * 1.45);
  }
});
