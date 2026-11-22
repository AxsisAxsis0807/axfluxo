import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionRecorder } from "../../src/services/video/local-recorder";

afterEach(() => vi.useRealTimers());

const transitions = [
  ["start", "inactive", "recording"],
  ["pause", "recording", "paused"],
  ["resume", "paused", "recording"],
  ["stop", "recording", "inactive"],
] as const;

describe.each(transitions)("%s", (operation, from, to) => {
  function setup() {
    const recorder = Object.assign(new EventTarget(), {
      state: from as RecordingState,
      [operation]: vi.fn(),
    });
    const controller = new AbortController();
    const pending = transitionRecorder(
      recorder as unknown as MediaRecorder,
      operation,
      controller.signal,
    );
    return { recorder, controller, pending };
  }
  it("waits for the matching native event and state, then ignores duplicates", async () => {
    const { recorder, pending } = setup();
    const acknowledged = vi.fn();
    void pending.then(acknowledged);
    recorder.dispatchEvent(new Event(operation));
    await Promise.resolve();
    expect(acknowledged).not.toHaveBeenCalled();
    recorder.state = to;
    recorder.dispatchEvent(new Event(operation));
    await pending;
    recorder.dispatchEvent(new Event(operation));
    expect(acknowledged).toHaveBeenCalledTimes(1);
  });
  it("times out if the native event never arrives", async () => {
    vi.useFakeTimers();
    const { pending } = setup();
    const stopped = expect(pending).rejects.toThrow("タイムアウト");
    await vi.advanceTimersByTimeAsync(30_000);
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels and releases the timer before a late event", async () => {
    vi.useFakeTimers();
    const { recorder, controller, pending } = setup();
    controller.abort(Error("cancelled"));
    recorder.state = to;
    recorder.dispatchEvent(new Event(operation));
    await expect(pending).rejects.toThrow("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("rejects resume from inactive without calling the native encoder", () => {
  const resume = vi.fn();
  expect(() =>
    transitionRecorder(
      { state: "inactive", resume } as unknown as MediaRecorder,
      "resume",
      new AbortController().signal,
    ),
  ).toThrow("録画の状態");
  expect(resume).not.toHaveBeenCalled();
});
