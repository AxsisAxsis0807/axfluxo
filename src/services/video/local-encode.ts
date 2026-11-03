export type LocalEncodeJob = {
  filename: string;
  width: number;
  height: number;
  pieces: { url: () => Promise<string>; start: number; end: number }[];
  draw: (
    ctx: CanvasRenderingContext2D,
    media: HTMLVideoElement,
    seconds: number,
  ) => void;
};
export function imageForEncode(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(Error("画像を読み込めません。"));
    image.src = url;
  });
}
export function recorderType() {
  if (typeof MediaRecorder === "undefined") return null;
  return (
    [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp8,opus",
    ].find((v) => MediaRecorder.isTypeSupported(v)) ?? null
  );
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
function mediaReady(
  media: HTMLVideoElement,
  event: "loadeddata" | "seeked",
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      media.removeEventListener(event, done);
      media.removeEventListener("error", fail);
      signal.removeEventListener("abort", fail);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(Error("素材を読み込めません。接続と形式を確認してください。"));
    };
    const timer = setTimeout(fail, 30_000);
    media.addEventListener(event, done, { once: true });
    media.addEventListener("error", fail, { once: true });
    signal.addEventListener("abort", fail, { once: true });
  });
}
async function playForEncode(
  media: HTMLVideoElement,
  signal: AbortSignal,
  status: (message: string) => void,
) {
  signal.throwIfAborted();
  try {
    await media.play();
    return;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotAllowedError")
      throw error;
  }
  signal.throwIfAborted();
  status("再生を許可して書き出しを続けてください。");
  await new Promise<void>((resolve, reject) => {
    const button = document.createElement("button");
    button.textContent = "再生を許可して書き出しを続ける";
    button.style.cssText =
      "position:fixed;bottom:24px;left:16px;right:16px;min-height:44px;z-index:10000";
    const cleanup = () => {
      button.remove();
      signal.removeEventListener("abort", cancelled);
    };
    const cancelled = () => {
      cleanup();
      reject(signal.reason);
    };
    button.onclick = () => {
      // Invoke play synchronously in the Safari tap; never await a network call here.
      void media.play().then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    };
    signal.addEventListener("abort", cancelled, { once: true });
    document.body.append(button);
  });
}
/** Real-time, on-device encoding. No render job or video upload is created. */
export async function encodeLocal(
  job: LocalEncodeJob,
  audio: AudioContext,
  signal: AbortSignal,
  rest: boolean,
  budget: { processing: number },
  status: (s: string) => void,
) {
  const mimeType = recorderType();
  if (!mimeType)
    throw Error(
      "このSafariは端末内エンコードに対応していません。対応ブラウザーを使用してください。",
    );
  const canvas = document.createElement("canvas");
  canvas.width = job.width;
  canvas.height = job.height;
  const ctx = canvas.getContext("2d");
  if (!ctx || !canvas.captureStream)
    throw Error("端末内エンコードに対応していません。");
  const media = document.createElement("video");
  media.crossOrigin = "anonymous";
  media.playsInline = true;
  // The element feeds only the recording destination, not the speakers.
  // Muting it would also mute MediaElementAudioSourceNode and produce silence.
  media.muted = false;
  media.preload = "auto";
  media.style.cssText =
    "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(media);
  const destination = audio.createMediaStreamDestination();
  const source = audio.createMediaElementSource(media);
  source.connect(destination);
  const stream = canvas.captureStream(60);
  destination.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 320_000,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  let recordError: Error | null = null;
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.onerror = () => {
    recordError = Error("端末内エンコードに失敗しました。");
  };
  let elapsed = 0;
  try {
    for (const piece of job.pieces) {
      signal.throwIfAborted();
      const url = await piece.url();
      signal.throwIfAborted();
      const ready = mediaReady(media, "loadeddata", signal);
      media.src = url;
      media.load();
      await ready;
      if (piece.start > 0) {
        const seek = mediaReady(media, "seeked", signal);
        media.currentTime = piece.start;
        await seek;
      }
      job.draw(ctx, media, elapsed);
      if (recorder.state === "inactive") {
        recorder.start(1000);
        recorder.pause();
      }
      await playForEncode(media, signal, status);
      recorder.resume();
      let last = media.currentTime,
        stalled = performance.now();
      while (media.currentTime < piece.end - 1 / 120) {
        signal.throwIfAborted();
        if (recordError) throw recordError;
        if (media.ended) {
          if (piece.end - media.currentTime > 0.1)
            throw Error("素材が指定区間より短いため停止しました。");
          break;
        }
        const current = media.currentTime;
        const delta = Math.max(0, current - last);
        budget.processing += delta;
        if (delta > 0) stalled = performance.now();
        if (performance.now() - stalled > 30_000)
          throw Error("再生が停止しました。接続を確認して再試行してください。");
        job.draw(ctx, media, elapsed + current - piece.start);
        last = current;
        if (rest && budget.processing >= 600) {
          media.pause();
          recorder.pause();
          status("4分休憩中（処理と録画を停止しています）");
          await wait(240_000, signal);
          budget.processing = 0;
          stalled = performance.now();
          await playForEncode(media, signal, status);
          recorder.resume();
        }
        status(
          `端末内で処理中：${Math.floor(elapsed + current - piece.start)}秒`,
        );
        await wait(16, signal);
      }
      media.pause();
      recorder.pause();
      elapsed += piece.end - piece.start;
    }
    recorder.stop();
    await stopped;
    if (recordError) throw recordError;
    return {
      blob: new Blob(chunks, { type: mimeType }),
      filename:
        job.filename.replace(/\.(mp4|webm)$/i, "") +
        (mimeType.startsWith("video/mp4") ? ".mp4" : ".webm"),
    };
  } finally {
    if (recorder.state !== "inactive") recorder.stop();
    media.pause();
    media.removeAttribute("src");
    media.load();
    media.remove();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
  }
}
