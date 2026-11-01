import { waveformSchema, type PreviewInfo } from "../../domain/video/preview";
/** Fetch peak metadata only; no WebAudio/media-file decoding. */
export async function loadWaveform(info: PreviewInfo, signal?: AbortSignal) {
  const response = await fetch(info.waveform, {
    signal,
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) throw new Error("WAVEFORM_UNAVAILABLE");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("WAVEFORM_UNAVAILABLE");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > 16 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("WAVEFORM_UNAVAILABLE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const value = waveformSchema.parse(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  if (value.hash !== info.hash || value.versionId !== info.versionId)
    throw new Error("SOURCE_MISSING");
  return value;
}
