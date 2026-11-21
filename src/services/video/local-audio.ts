export const audioFileAccept =
  "audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.opus";

export function isDirectAudioFile(file: File) {
  return (
    file.type.startsWith("audio/") ||
    (!file.type.startsWith("video/") &&
      /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus)$/i.test(file.name))
  );
}

/** Native decode is the playback gate. Container inspection only reads bounded Blob ranges. */
export async function localAudioDetails(file: File, url: string) {
  if (file.size === 0) throw Error("音声ファイルが空です。別のファイルを選択してください。");
  const duration = await new Promise<number>((resolve, reject) => {
    const media = new Audio();
    media.preload = "auto";
    const finish = (error?: Error) => {
      const duration = media.duration;
      clearTimeout(timer);
      media.onloadeddata = media.onerror = null;
      media.removeAttribute("src");
      media.load();
      if (error) reject(error);
      else if (!Number.isFinite(duration) || duration <= 0)
        reject(Error("音声ファイルの再生時間を取得できません。"));
      else resolve(duration);
    };
    const timer = setTimeout(
      () => finish(Error("音声の読み込みがタイムアウトしました。")),
      30_000,
    );
    media.onloadeddata = () => finish();
    media.onerror = () =>
      finish(
        Error(
          "このブラウザーでは音声形式を再生できないか、ファイルが破損しています。MP3、WAV、M4Aなど再生可能なファイルを選択してください。",
        ),
      );
    media.src = url;
  });
  let sampleRate: number | null = null;
  let channels: number | null = null;
  try {
    const { Input, BlobSource, ALL_FORMATS } = await import("mediabunny");
    const input = new Input({
      source: new BlobSource(file, {
        maxCacheSize: 2 * 1024 ** 2,
        useStreamReader: false,
      }),
      formats: ALL_FORMATS,
    });
    try {
      const audio = await input.getPrimaryAudioTrack();
      if (audio) {
        sampleRate = await audio.getSampleRate();
        channels = await audio.getNumberOfChannels();
      }
    } finally {
      input.dispose();
    }
  } catch {
    // A browser can play formats whose optional container metadata cannot be inspected.
  }
  return { duration, sampleRate, channels };
}
