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
    if (expectedDuration !== undefined && video) {
      const duration = await video.computeDuration();
      if (
        !Number.isFinite(duration) ||
        duration < expectedDuration - Math.min(0.35, expectedDuration / 3)
      ) {
        const error = Error(
          "完成動画の映像が指定区間より短いため、保存を停止しました。",
        );
        error.name = "LocalVideoOutputError";
        throw error;
      }
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
