import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import {
  showcaseAnalyzer,
  type ShowcaseFeatures,
} from "../../domain/video/music-showcase-analysis";
import {
  inspectTimedAudio,
  localAudioRate,
  timedAudio,
} from "./local-timed-audio";
import type { Source } from "./local-project";

export function showcaseFeatureProvider() {
  // Only identical ranges of the same immutable File may reuse the analysis.
  // One cached range per build bounds retained feature memory.
  let cached:
    { file: File; key: string; features: ShowcaseFeatures } | undefined;
  return async (
    source: Source,
    start: number,
    end: number,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const key = JSON.stringify([start, end, source.duration]);
    if (cached?.file === source.file && cached.key === key)
      return cached.features;
    cached = undefined;
    const samples = Math.round((end - start) * localAudioRate);
    const analyzer = showcaseAnalyzer(samples);
    const input = new Input({
      source: new BlobSource(source.file),
      formats: ALL_FORMATS,
    });
    try {
      const audio = await input.getPrimaryAudioTrack();
      if (!audio) throw Error("曲紹介に使える音声トラックがありません。");
      const plan = await inspectTimedAudio(
        audio,
        start,
        end,
        source.duration,
        signal,
        source.file,
      );
      for await (const sample of timedAudio(
        audio,
        plan,
        0,
        samples,
        signal,
        source.file,
      )) {
        try {
          signal.throwIfAborted();
          const left = new Float32Array(sample.numberOfFrames);
          const right = new Float32Array(sample.numberOfFrames);
          sample.copyTo(left, { planeIndex: 0, format: "f32-planar" });
          sample.copyTo(right, { planeIndex: 1, format: "f32-planar" });
          // Yield within each bounded PCM block rather than holding the UI for one second of FFTs.
          for (let offset = 0; offset < left.length; offset += 6400) {
            analyzer.add(
              left.subarray(offset, offset + 6400),
              right.subarray(offset, offset + 6400),
            );
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            signal.throwIfAborted();
          }
        } finally {
          sample.close();
        }
      }
      signal.throwIfAborted();
      const features = analyzer.finish();
      cached = { file: source.file, key, features };
      return features;
    } finally {
      input.dispose();
    }
  };
}
