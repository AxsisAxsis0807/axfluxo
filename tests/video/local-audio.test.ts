import { afterEach, expect, it, vi } from "vitest";
import { localAudioDetails } from "../../src/services/video/local-audio";

// Keep this regression independent of codec support in the CI host.
vi.mock("mediabunny", () => ({
  Input: class {
    async getPrimaryAudioTrack() {
      return null;
    }
    dispose() {}
  },
  BlobSource: class {},
  ALL_FORMATS: [],
}));

class FakeAudio {
  static current: FakeAudio;
  duration = Number.NaN;
  readyState = 0;
  networkState = 2;
  preload = "";
  src = "";
  onloadedmetadata: (() => void) | null = null;
  ondurationchange: (() => void) | null = null;
  onloadeddata: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeAudio.current = this;
  }

  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }

  load() {}
}

function file(contents = "sample") {
  return new File([contents], "sample.mp3", { type: "audio/mpeg" });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("accepts finite duration metadata without waiting for loadeddata", async () => {
  vi.stubGlobal("Audio", FakeAudio);
  const pending = localAudioDetails(file(), "blob:test");
  const media = FakeAudio.current;
  expect(media.preload).toBe("metadata");
  media.duration = 105.74;
  media.onloadedmetadata?.();
  await expect(pending).resolves.toEqual({
    duration: 105.74,
    sampleRate: null,
    channels: null,
  });
  expect(media.onloadeddata).toBeNull();
});

it("waits for finite durationchange when metadata reports Infinity", async () => {
  vi.stubGlobal("Audio", FakeAudio);
  const pending = localAudioDetails(file(), "blob:test");
  const media = FakeAudio.current;
  media.duration = Infinity;
  media.onloadedmetadata?.();
  media.duration = 42.5;
  media.ondurationchange?.();
  await expect(pending).resolves.toMatchObject({ duration: 42.5 });
});

it("rejects a media decode error without accepting bad files", async () => {
  vi.stubGlobal("Audio", FakeAudio);
  const pending = localAudioDetails(file(), "blob:test");
  FakeAudio.current.onerror?.();
  await expect(pending).rejects.toThrow("音声形式を再生できない");
});

it("retains the bounded timeout when no metadata event arrives", async () => {
  vi.stubGlobal("Audio", FakeAudio);
  vi.useFakeTimers();
  const pending = localAudioDetails(file(), "blob:test");
  const rejected = expect(pending).rejects.toThrow("タイムアウト");
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
});

it("rejects empty audio files immediately", async () => {
  await expect(localAudioDetails(file(""), "blob:test")).rejects.toThrow(
    "音声ファイルが空です",
  );
});
