import { TrackFeatures, type BoundarySettings } from "./track-boundaries";
let features: TrackFeatures;
self.onmessage = (
  event: MessageEvent<{
    type: "init" | "chunk" | "finish";
    duration: number;
    channels: Float32Array[];
    sampleRate: number;
    timestamp: number;
    from: number;
    until: number;
    settings: BoundarySettings;
  }>,
) => {
  try {
    const data = event.data;
    if (data.type === "init") features = new TrackFeatures(data.duration);
    if (data.type === "chunk")
      features.add(
        data.channels,
        data.sampleRate,
        data.timestamp,
        data.from,
        data.until,
      );
    self.postMessage(
      data.type === "finish"
        ? {
            candidates: features.detect(data.settings),
            levels: features.levels(),
          }
        : { ok: true },
    );
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "解析に失敗しました。",
    });
  }
};
