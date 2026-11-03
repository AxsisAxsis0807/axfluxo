import { afterEach, expect, it, vi } from "vitest";
import { encodeLocal } from "../src/services/video/local-encode";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("pauses recording and playback for four minutes after ten minutes and excludes rest from output time", async () => {
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
    play: async () => {
      playing = true;
      started = Date.now();
    },
    pause: () => {
      if (playing) position += (Date.now() - started) / 1000;
      playing = false;
    },
    load() {
      setTimeout(() => media.dispatchEvent(new Event("loadeddata")), 0);
    },
    remove: vi.fn(),
    removeAttribute: vi.fn(),
  });
  Object.defineProperty(media, "currentTime", {
    get: () => position + (playing ? (Date.now() - started) / 1000 : 0),
  });
  const ctx = {};
  const stream = { addTrack: vi.fn(), getTracks: () => tracks };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    captureStream: () => stream,
  };
  vi.stubGlobal("document", {
    createElement: (tag: string) => (tag === "canvas" ? canvas : media),
    body: { append: vi.fn() },
  });
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    onstop: (() => void) | null = null;
    start() {
      this.state = "recording";
      states.push("start");
    }
    pause() {
      this.state = "paused";
      states.push("pause");
    }
    resume() {
      this.state = "recording";
      states.push("resume");
    }
    stop() {
      this.state = "inactive";
      states.push("stop");
      this.onstop?.();
    }
  }
  vi.stubGlobal("MediaRecorder", Recorder);
  const audio = {
    createMediaStreamDestination: () => ({
      stream: { getAudioTracks: () => [] },
    }),
    createMediaElementSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
  } as unknown as AudioContext;
  const status = vi.fn(),
    signal = new AbortController().signal;
  const result = encodeLocal(
    {
      filename: "test.mp4",
      width: 320,
      height: 180,
      pieces: [{ url: async () => "https://source.test", start: 0, end: 601 }],
      draw: vi.fn(),
    },
    audio,
    signal,
    true,
    { processing: 0 },
    status,
  );
  await vi.advanceTimersByTimeAsync(600_100);
  expect(status).toHaveBeenLastCalledWith(
    "4分休憩中（処理と録画を停止しています）",
  );
  expect(states.at(-1)).toBe("pause");
  const pausedAt = (media as unknown as HTMLVideoElement).currentTime;
  await vi.advanceTimersByTimeAsync(239_000);
  expect((media as unknown as HTMLVideoElement).currentTime).toBe(pausedAt);
  expect(states.at(-1)).toBe("pause");
  await vi.advanceTimersByTimeAsync(2_000);
  expect((await result).filename).toBe("test.mp4");
  expect(states.at(-1)).toBe("stop");
  expect(
    (media as unknown as HTMLVideoElement).currentTime,
  ).toBeGreaterThanOrEqual(600.98);
  expect((media as unknown as HTMLVideoElement).currentTime).toBeLessThan(
    601.1,
  );
  expect(tracks[0].stop).toHaveBeenCalled();
});
