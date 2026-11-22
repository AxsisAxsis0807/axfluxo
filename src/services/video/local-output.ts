import type { EncodedPacket } from "mediabunny";

async function checkPacketContinuity(
  packets: AsyncIterable<EncodedPacket>,
  kind: "映像" | "音声",
  signal: AbortSignal,
) {
  let sequence = -Infinity;
  let latest = -Infinity;
  let audioEnd = -Infinity;
  // Video arrives in decode order. Keep a bounded presentation-time window
  // so B-frame reordering does not look like a gap or a reversed timestamp.
  const window: number[] = [];
  let presented = -Infinity;
  const invalid = () => {
    const error = Error(
      `完成動画の${kind}の途中に時刻の欠落または重複があるため、保存を停止しました。`,
    );
    if (kind === "映像") error.name = "LocalVideoOutputError";
    return error;
  };
  const advance = (timestamp: number) => {
    if (
      timestamp < presented ||
      (timestamp - presented > 1.25 && Number.isFinite(presented))
    )
      throw invalid();
    presented = timestamp;
  };
  for await (const { timestamp, duration, sequenceNumber } of packets) {
    signal.throwIfAborted();
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      sequenceNumber <= sequence
    )
      throw invalid();
    sequence = sequenceNumber;
    if (kind === "音声") {
      // Small overlaps are normal with encoder priming and WebM rounding.
      if (
        timestamp <= latest ||
        (timestamp - latest > 0.5 && Number.isFinite(latest)) ||
        timestamp < audioEnd - 0.1 ||
        (timestamp > audioEnd + 0.5 && Number.isFinite(audioEnd))
      )
        throw invalid();
      latest = timestamp;
      audioEnd = Math.max(audioEnd, timestamp + duration);
      continue;
    }
    const index = window.findIndex((value) => value > timestamp);
    window.splice(index === -1 ? window.length : index, 0, timestamp);
    if (window.length > 16) advance(window.shift()!);
  }
  for (const timestamp of window) advance(timestamp);
}

/** Validate actual encoded packets before exposing or persisting a completed file.
 * A MIME support claim or nonempty Blob alone does not prove a playable video. */
export async function validateLocalOutput(
  blob: Blob,
  signal: AbortSignal,
  expectedDuration?: number,
) {
  signal.throwIfAborted();
  const {
    Input,
    BlobSource,
    ALL_FORMATS,
    EncodedPacketSink,
    UnsupportedInputFormatError,
  } = await import("mediabunny");
  const input = new Input({
    source: new BlobSource(blob, {
      maxCacheSize: 2 * 1024 * 1024,
      useStreamReader: false,
    }),
    formats: ALL_FORMATS,
  });
  try {
    const format = await input.getFormat();
    const declared = blob.type.split(";")[0];
    if (declared && format.mimeType !== declared)
      throw Error(
        "生成された動画形式が要求した形式と一致しません。別の対応形式で再試行してください。",
      );
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const missing: string[] = [];
    if (!video || !(await new EncodedPacketSink(video).getFirstPacket()))
      missing.push("映像");
    if (!audio || !(await new EncodedPacketSink(audio).getFirstPacket()))
      missing.push("音声");
    if (missing.length) {
      const error = Error(
        `完成動画の映像または音声を生成できませんでした（未検出: ${missing.join("・")}）。端末を前面に保ち、負荷を減らして再試行してください。`,
      );
      if (missing.length === 1 && missing[0] === "映像")
        error.name = "LocalVideoOutputError";
      throw error;
    }
    if (expectedDuration !== undefined && video && audio) {
      // These calls inspect packet timestamps through the bounded Blob cache.
      // Neither the video pixels nor the audio samples are decoded.
      const [videoStart, videoEnd, audioStart, audioEnd] = await Promise.all([
        video.getFirstTimestamp(),
        video.computeDuration(),
        audio.getFirstTimestamp(),
        audio.computeDuration(),
      ]);
      const tolerance = Math.min(0.35, expectedDuration / 3);
      if (
        !Number.isFinite(videoStart) ||
        !Number.isFinite(videoEnd) ||
        videoEnd - videoStart < expectedDuration - tolerance
      ) {
        const error = Error(
          "完成動画の映像が指定区間より短いため、保存を停止しました。",
        );
        error.name = "LocalVideoOutputError";
        throw error;
      }
      if (
        !Number.isFinite(audioStart) ||
        !Number.isFinite(audioEnd) ||
        audioEnd - audioStart < expectedDuration - tolerance
      )
        throw Error(
          "完成動画の音声が指定区間より短いため、保存を停止しました。",
        );
      // Count unintended recorder warm-up or pause time as an overrun.
      if (
        Math.max(videoEnd - videoStart, audioEnd - audioStart) >
        expectedDuration + 0.5
      ) {
        const error = Error(
          "完成動画に指定区間を超える録画時間が含まれるため、保存を停止しました。",
        );
        error.name = "LocalVideoOutputError";
        throw error;
      }
      if (
        Math.abs(videoStart - audioStart) > 0.4 ||
        Math.abs(videoEnd - audioEnd) > 0.4
      )
        throw Error(
          "完成動画の映像と音声の記録時刻が一致しないため、保存を停止しました。",
        );
    }
    if (video && audio) {
      const timingOnly = { metadataOnly: true };
      await checkPacketContinuity(
        new EncodedPacketSink(video).packets(undefined, undefined, timingOnly),
        "映像",
        signal,
      );
      await checkPacketContinuity(
        new EncodedPacketSink(audio).packets(undefined, undefined, timingOnly),
        "音声",
        signal,
      );
    }
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof UnsupportedInputFormatError) {
      const failure = Error(
        "完成動画の記録データを読み取れなかったため、保存を停止しました。",
      );
      failure.name = "LocalVideoOutputError";
      throw failure;
    }
    throw error;
  } finally {
    input.dispose();
  }
}
