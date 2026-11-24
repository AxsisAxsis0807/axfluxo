import { describe, expect, it } from "vitest";
import { terminalAudioShortfall } from "../../src/services/video/local-timed-audio";

describe("bounded full-source audio EOF correction", () => {
  const rate = 48000, end = 5382144;
  it("accepts the 2047-sample MP3 clock discrepancy without changing the requested duration", () => {
    expect(terminalAudioShortfall("mp3", rate, 0, end, end - 2047, end / rate, end / rate)).toBe(2047);
  });
  it("keeps an exact WAV or trimmed range unchanged", () => {
    expect(terminalAudioShortfall("pcm-s16", rate, 100, end, end, end / rate, undefined)).toBe(0);
  });
  it("allows at most two AAC-LC frames at natural EOF", () => {
    expect(terminalAudioShortfall("aac", rate, 0, end, end - 2048, end / rate, end / rate)).toBe(2048);
    expect(() => terminalAudioShortfall("aac", rate, 0, end, end - 2049, end / rate, end / rate)).toThrow();
  });
  it("rejects arbitrary trims, PCM shortages, missing source duration and large losses", () => {
    for (const args of [
      ["mp3", rate, 0, end, end - 2047, end / rate, (end + rate) / rate],
      ["pcm-s16", rate, 0, end, end - 1, end / rate, end / rate],
      ["mp3", rate, 0, end, end - 2047, end / rate, undefined],
      ["mp3", rate, 0, end, end - 2305, end / rate, end / rate],
      ["mp3", rate, 0, end, end - 2047, (end + rate) / rate, end / rate],
      ["mp3", rate, end - 1, end, end - 1, end / rate, end / rate],
    ] as const) expect(() => terminalAudioShortfall(...args)).toThrow();
  });
});
