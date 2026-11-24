import { describe, expect, it, vi } from "vitest";
import { AudioSample, type InputAudioTrack } from "mediabunny";
import { inspectTimedAudio, terminalAudioShortfall, timedAudio } from "../../src/services/video/local-timed-audio";

vi.mock("mediabunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mediabunny")>();
  return {
    ...actual,
    AudioSampleSink: class {
      constructor(private readonly track: { fixture: () => AsyncGenerator<AudioSample> }) {}
      samples() { return this.track.fixture(); }
    },
  };
});

function source(spans: readonly (readonly [number, number])[]) {
  return {
    getSampleRate: async () => 48000,
    getNumberOfChannels: async () => 2,
    getCodec: async () => "mp3",
    computeDuration: async () => 2.304,
    async *fixture() {
      for (const [first, frames] of spans) {
        yield new AudioSample({
          data: new Float32Array(frames * 2).fill(0.25),
          format: "f32-planar",
          numberOfChannels: 2,
          sampleRate: 48000,
          timestamp: first / 48000,
        });
      }
    },
  } as unknown as InputAudioTrack;
}
const signal = () => new AbortController().signal;
const completeSpans = [[0, 48000], [48000, 48000], [96000, 12545]] as const;


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
    const cases: Parameters<typeof terminalAudioShortfall>[] = [
      ["mp3", rate, 0, end, end - 2047, end / rate, (end + rate) / rate],
      ["pcm-s16", rate, 0, end, end - 1, end / rate, end / rate],
      ["mp3", rate, 0, end, end - 2047, end / rate, undefined],
      ["mp3", rate, 0, end, end - 2305, end / rate, end / rate],
      ["mp3", rate, 0, end, end - 2047, (end + rate) / rate, end / rate],
      ["mp3", rate, end - 1, end, end - 1, end / rate, end / rate],
    ];
    for (const args of cases) expect(() => terminalAudioShortfall(...args)).toThrow();
  });
});

describe("preflight and second-pass PCM invariants", () => {
  it("retains all decoded PCM and fills only the measured terminal shortage", async () => {
    const plan = await inspectTimedAudio(source(completeSpans), 0, 2.304, 2.304, signal());
    expect(plan.decodedEnd).toBe(108545);
    expect(plan.limit - plan.decodedEnd).toBe(2047);
    let count = 0;
    // Nonzero output start models a later piece after a separate file gap.
    const offset = 72000;
    for await (const sample of timedAudio(source(completeSpans), plan, offset, offset + 110592, signal())) {
      try {
        expect(Math.round(sample.timestamp * 48000)).toBe(offset + count);
        for (let channel = 0; channel < 2; channel++) {
          const pcm = new Float32Array(sample.numberOfFrames);
          sample.copyTo(pcm, { planeIndex: channel, format: "f32-planar" });
          expect(pcm.every((value, i) => value === (count + i < 108545 ? 0.25 : 0))).toBe(true);
        }
        count += sample.numberOfFrames;
      } finally { sample.close(); }
    }
    expect(count).toBe(110592);
  });

  it("rejects a missing interior sample before encoding", async () => {
    await expect(inspectTimedAudio(
      source([[0, 48000], [48001, 48000], [96001, 12544]]),
      0, 2.304, 2.304, signal(),
    )).rejects.toThrow("欠落");
  });

  it("rejects a second decode whose EOF differs from the inspected plan", async () => {
    const plan = await inspectTimedAudio(source(completeSpans), 0, 2.304, 2.304, signal());
    const consume = async () => {
      for await (const sample of timedAudio(
        source([[0, 48000], [48000, 48000], [96000, 12544]]),
        plan, 0, 110592, signal(),
      )) sample.close();
    };
    await expect(consume()).rejects.toThrow("一致しません");
  });
});
