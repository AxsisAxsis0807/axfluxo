/** Validate actual encoded packets before exposing or persisting a completed file.
 * A MIME support claim or nonempty Blob alone does not prove a playable video. */
export async function validateLocalOutput(
  blob: Blob,
  signal: AbortSignal,
  timing?: { duration: number; legacyRecorder?: boolean },
) {
  signal.throwIfAborted();
  const { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } =
    await import("mediabunny");
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
    if (
      !video ||
      !audio ||
      !(await new EncodedPacketSink(video).getFirstPacket()) ||
      !(await new EncodedPacketSink(audio).getFirstPacket())
    )
      throw Error(
        "完成動画の映像または音声を生成できませんでした。端末を前面に保ち、負荷を減らして再試行してください。",
      );
    if (timing) {
      const durations = await Promise.all([
        video.computeDuration(),
        audio.computeDuration(),
      ]);
      // Regular MP4 timestamps use different track timescales. Allow only
      // one millisecond of rounding on the explicit-timestamp path.
      const tolerance = timing.legacyRecorder ? 0.05 : 0.001;
      if (
        durations.some(
          (duration) =>
            !Number.isFinite(duration) ||
            Math.abs(duration - timing.duration) > tolerance,
        )
      )
        throw Error(
          "完成動画の音声・映像時間が指定区間に一致しません。負荷を減らして再試行してください。",
        );

      if (timing.legacyRecorder) {
        const packets = new EncodedPacketSink(audio);
        let expectedEnd = 0;
        for await (const packet of packets.packets(undefined, undefined, {
          metadataOnly: true,
        })) {
          signal.throwIfAborted();
          if (Math.abs(expectedEnd - packet.timestamp) > tolerance)
            throw Error(
              "録画中に音声時刻の不連続を検出しました。負荷を減らして再試行してください。",
            );
          expectedEnd = packet.timestamp + packet.duration;
        }
      }
    }
    signal.throwIfAborted();
  } finally {
    input.dispose();
  }
}
