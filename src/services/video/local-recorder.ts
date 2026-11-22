const transitions = {
  start: { from: "inactive", to: "recording", label: "開始" },
  pause: { from: "recording", to: "paused", label: "一時停止" },
  resume: { from: "paused", to: "recording", label: "再開" },
  stop: { from: ["paused", "recording"], to: "inactive", label: "停止" },
} as const;

/** Acknowledge each native transition before advancing the source clock. */
export function transitionRecorder(
  recorder: MediaRecorder,
  operation: keyof typeof transitions,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { from, to, label } = transitions[operation];
  if (
    !(Array.isArray(from)
      ? (from as readonly string[]).includes(recorder.state)
      : from === recorder.state)
  )
    throw Error(`録画の状態が変わったため、${label}できませんでした。`);
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      recorder.removeEventListener(operation, acknowledged);
      recorder.removeEventListener("error", failed);
      recorder.removeEventListener("stop", stopped);
      signal.removeEventListener("abort", cancelled);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const acknowledged = () => {
      if (signal.aborted) cancelled();
      else if (recorder.state === to) finish();
    };
    const failed = () =>
      finish(Error(`録画の${label}中にエラーが発生しました。`));
    const stopped = () => finish(Error("録画が途中で停止しました。"));
    const cancelled = () => finish(signal.reason);
    const timer = setTimeout(
      () => finish(Error(`録画の${label}がタイムアウトしました。`)),
      30_000,
    );
    recorder.addEventListener(operation, acknowledged);
    recorder.addEventListener("error", failed);
    if (operation !== "stop") recorder.addEventListener("stop", stopped);
    signal.addEventListener("abort", cancelled, { once: true });
    try {
      if (operation === "start") recorder.start(1000);
      else recorder[operation]();
    } catch (error) {
      finish(error);
    }
  });
}
