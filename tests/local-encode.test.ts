import { afterEach, expect, it, vi } from "vitest";
import { validateLocalOutput } from "../src/services/video/local-output";
vi.mock("../src/services/video/local-output", () => ({
  validateLocalOutput: vi.fn(async () => {}),
}));
import { encodeLocal } from "../src/services/video/local-encode";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
for (const [kind, cancelDuringRest] of [
  ["video", false],
  ["video", true],
  ["audio", false],
] as const)
  it(`pauses ${kind} recording and playback during rest (cancel=${cancelDuringRest})`, async () => {
    vi.useFakeTimers();
    const states: string[] = [],
      tracks = [{ stop: vi.fn() }];
    let position = 0,
      started = 0,
      playing = false;
    const media = Object.assign(new EventTarget(), {
      style: { cssText: "" },
      src: "",
      ended: false,
      readyState: 0,
      videoWidth: 320,
      videoHeight: 180,
      play: async () => {
        media.readyState = kind === "video" ? 2 : 1;
        playing = true;
        started = Date.now();
      },
      pause: () => {
        if (playing) position += (Date.now() - started) / 1000;
        playing = false;
      },
      load() {
        media.readyState = 0;
        setTimeout(() => {
          media.readyState = 1;
          media.dispatchEvent(new Event("loadedmetadata"));
        }, 0);
      },
      remove: vi.fn(),
      removeAttribute: vi.fn(),
    });
    Object.defineProperty(media, "currentTime", {
      get: () => position + (playing ? (Date.now() - started) / 1000 : 0),
    });
    const ctx = { fillRect: vi.fn() };
    const stream = {
      addTrack: vi.fn(),
      getTracks: () => tracks,
      getVideoTracks: () => tracks,
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      captureStream: (frameRate: number) => {
        expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 320, 180);
        expect(frameRate).toBe(60);
        return stream;
      },
    };
    vi.stubGlobal("document", {
      createElement: (tag: string) => (tag === "canvas" ? canvas : media),
      body: { append: vi.fn() },
    });
    class Recorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }
      state = "inactive";
      start() {
        this.state = "recording";
        states.push("start");
        setTimeout(() => {
          expect(playing).toBe(false);
          expect(position).toBe(0);
          this.dispatchEvent(new Event("start"));
        }, 100);
      }
      pause() {
        this.state = "paused";
        states.push("pause");
        this.dispatchEvent(new Event("pause"));
      }
      resume() {
        this.state = "recording";
        states.push("resume");
        expect(playing).toBe(false);
        this.dispatchEvent(new Event("resume"));
      }
      stop() {
        this.state = "inactive";
        states.push("stop");
        this.dispatchEvent(new Event("stop"));
      }
    }
    vi.stubGlobal("MediaRecorder", Recorder);
    let audioState: AudioContextState = "running";
    const resumeAudio = vi.fn(async () => {
      audioState = "running";
    });
    const audio = {
      get state() {
        return audioState;
      },
      resume: resumeAudio,
      createMediaStreamDestination: () => ({
        stream: {
          getAudioTracks: () => [{ readyState: "live", stop: vi.fn() }],
        },
      }),
      createMediaElementSource: () => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
    } as unknown as AudioContext;
    const status = vi.fn(),
      controller = new AbortController(),
      signal = controller.signal;
    const result = encodeLocal(
      {
        filename: "test.mp4",
        width: 320,
        height: 180,
        pieces: [
          { kind, url: async () => "https://source.test", start: 0, end: 601 },
        ],
        draw: vi.fn(),
      },
      audio,
      signal,
      true,
      { processing: 0 },
      status,
    );
    await vi.advanceTimersByTimeAsync(600_250);
    expect(status).toHaveBeenLastCalledWith(
      "4分休憩中（処理と録画を停止しています）",
    );
    expect(states).toEqual(["start", "pause"]);
    const pausedAt = (media as unknown as HTMLVideoElement).currentTime;
    if (cancelDuringRest) {
      const rejected = expect(result).rejects.toThrow("cancelled during rest");
      controller.abort(Error("cancelled during rest"));
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(tracks[0].stop).toHaveBeenCalled();
      expect(states.at(-1)).toBe("stop");
      return;
    }
    audioState = "suspended";
    await vi.advanceTimersByTimeAsync(239_000);
    expect((media as unknown as HTMLVideoElement).currentTime).toBe(pausedAt);
    expect(states.at(-1)).toBe("pause");
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await result).filename).toBe("test.mp4");
    expect(resumeAudio).toHaveBeenCalledTimes(1);
    expect(validateLocalOutput).toHaveBeenCalled();
    expect(states).toEqual(["start", "pause", "resume", "stop"]);
    expect(
      (media as unknown as HTMLVideoElement).currentTime,
    ).toBeGreaterThanOrEqual(600.98);
    expect((media as unknown as HTMLVideoElement).currentTime).toBeLessThan(
      601.1,
    );
    expect(tracks[0].stop).toHaveBeenCalled();
  });
