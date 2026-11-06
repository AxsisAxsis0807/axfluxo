import { describe, it, expect } from "vitest";
import {
  TrackFeatures,
  DEFAULT_BOUNDARY_SETTINGS as defaults,
} from "../../../src/services/video/track-boundaries";
const rate = 8000;
function fixture(
  duration: number,
  sample: (time: number) => number,
  stereo = false,
) {
  const features = new TrackFeatures(duration);
  // Simulates bounded decoder chunks, with unequal stereo levels and no cancellation.
  for (let offset = 0; offset < duration; offset += 4) {
    const count = Math.round(Math.min(4, duration - offset) * rate);
    const channel = Float32Array.from({ length: count }, (_, i) =>
      sample(offset + i / rate),
    );
    features.add(
      stereo ? [channel, channel.map((v) => -v * 0.03)] : [channel],
      rate,
      offset,
      offset,
      Math.min(duration, offset + 4),
    );
  }
  return features;
}
const tone = (t: number, hz = 220) => 0.5 * Math.sin(2 * Math.PI * hz * t);
const gap = (t: number, end = 21) =>
  t < 20 ? tone(t) : t < end ? 0 : tone(t, 1400);
describe("generated PCM track boundaries", () => {
  it("finds exact silence between active tracks with source-aligned start/end", () => {
    const result = fixture(42, gap).detect(defaults);
    expect(result).toEqual([
      expect.objectContaining({
        startUs: 20e6,
        endUs: 21e6,
        timeUs: 20.5e6,
        confidence: "high",
        reason: "silence",
      }),
    ]);
  });
  it("detects a 0.2 second gap when the surrounding acoustic profiles change", () => {
    const result = fixture(42, (t) => gap(t, 20.2)).detect(defaults);
    expect(result.some((c) => c.startUs === 20e6 && c.endUs === 20.2e6)).toBe(
      true,
    );
  });
  it("handles decaying reverb without calling it digital silence", () => {
    const result = fixture(44, (t) =>
      t < 20
        ? tone(t)
        : t < 23
          ? tone(t) * Math.exp(-(t - 20) * 4)
          : tone(t, 1400),
    ).detect(defaults);
    expect(
      result.some(
        (c) => c.reason === "low-level" && c.timeUs > 20e6 && c.timeUs < 23e6,
      ),
    ).toBe(true);
  });
  it("finds low-level recording noise", () => {
    const result = fixture(42, (t) =>
      t >= 20 && t < 21 ? 0.001 * Math.sin(t * 12345) : gap(t),
    ).detect(defaults);
    expect(
      result.some((c) => c.reason === "low-level" && c.confidence !== "high"),
    ).toBe(true);
  });
  it("treats an identical restart after a short musical break as ambiguous", () => {
    const result = fixture(42, (t) =>
      t >= 20 && t < 20.2 ? 0 : tone(t),
    ).detect(defaults);
    expect(result.every((c) => c.confidence !== "high")).toBe(true);
  });
  it("offers only low confidence for gapless timbral transitions", () => {
    const result = fixture(42, (t) => tone(t, t < 20 ? 220 : 1400)).detect(
      defaults,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((c) => c.confidence === "low")).toBe(true);
  });
  it("offers at most low confidence for crossfade", () => {
    const result = fixture(44, (t) => {
      const fade = Math.min(1, Math.max(0, (t - 20) / 2));
      return tone(t) * (1 - fade) + tone(t, 1400) * fade;
    }).detect(defaults);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((c) => c.confidence === "low")).toBe(true);
  });
  it("merges nearby evidence and ranks known counts without inventing candidates", () => {
    const sample = (t: number) =>
      t % 30 >= 20 && t % 30 < 21 ? 0 : tone(t, t < 21 ? 220 : 1400);
    const features = fixture(100, sample);
    const result = features.detect(defaults);
    expect(result.length).toBe(3);
    expect(features.detect({ ...defaults, expectedVersions: 2 })).toHaveLength(
      1,
    );
    expect(
      fixture(42, (t) => tone(t)).detect({ ...defaults, expectedVersions: 10 }),
    ).toEqual([]);
  });
  it("does not cancel unequal anti-phase stereo", () => {
    expect(fixture(42, gap, true).detect(defaults)[0].confidence).toBe("high");
  });
  it("returns no candidates for an all-silent file", () => {
    expect(fixture(42, () => 0).detect(defaults)).toEqual([]);
  });
  it("refuses missing PCM and bounds long-file feature storage", () => {
    expect(() => new TrackFeatures(10).detect(defaults)).toThrow("一部");
    expect(() => new TrackFeatures(21601)).toThrow("6時間");
    expect(new TrackFeatures(3600).frames).toHaveLength(180000);
  });
  it("benchmarks 10 minutes of streamed PCM", () => {
    const start = performance.now();
    const result = fixture(600, (t) => {
      const phase = t % 60;
      if (phase >= 20 && phase < 21) return 0;
      const alternate = Math.floor(t / 60) % 2 === 0;
      return tone(t, phase < 20 === alternate ? 220 : 1400);
    }).detect(defaults);
    console.info(
      JSON.stringify({
        seconds: 600,
        sampleRate: rate,
        elapsedMs: Math.round(performance.now() - start),
        featureFrames: 30000,
        candidates: result.length,
      }),
    );
    expect(result.length).toBe(10);
  });
});
