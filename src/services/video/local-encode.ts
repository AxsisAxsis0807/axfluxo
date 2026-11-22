import { transitionRecorder } from "./local-recorder";
import { validateLocalOutput } from "./local-output";
import type { LocalProjectData } from "./local-project";
export type LocalEncodeJob = {
  recovery?: { project: LocalProjectData; index: number };
  filename: string;
  width: number;
  height: number;
  pieces: {
    kind?: "audio" | "video";
    name?: string;
    file?: File;
    url: () => Promise<string>;
    start: number;
    end: number;
  }[];
  draw: (
    ctx: CanvasRenderingContext2D,
    media: HTMLVideoElement,
    seconds: number,
  ) => void;
  drawAudio?: (ctx: CanvasRenderingContext2D, seconds: number) => void;
};
export function imageForEncode(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const timer = setTimeout(() => {
      image.onload = null;
      image.onerror = null;
      reject(Error("画像の読み込みがタイムアウトしました。"));
    }, 30000);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(Error("画像を読み込めません。"));
    };
    image.src = url;
  });
}
export function recorderType() {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  )
    return null;
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
  media: HTMLMediaElement,
  events: readonly string[],
  ready: () => boolean,
  signal: AbortSignal,
  timeoutMessage: string,
  begin: () => void = () => {},
) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cleanup = () => {
      clearTimeout(timer);
      events.forEach((event) => media.removeEventListener(event, check));
      media.removeEventListener("error", failed);
      signal.removeEventListener("abort", cancelled);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const check = () => {
      if (!ready()) return;
      cleanup();
      resolve();
    };
    const failed = () =>
      fail(Error("素材を読み込めません。接続と形式を確認してください。"));
    const cancelled = () => fail(signal.reason);
    const timer = setTimeout(() => fail(Error(timeoutMessage)), 30_000);
    events.forEach((event) => media.addEventListener(event, check));
    media.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", cancelled, { once: true });
    try {
      begin();
      if (media.error) failed();
      else check();
    } catch (error) {
      fail(error);
    }
  });
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}
async function playWithPermission(
  media: HTMLMediaElement,
  signal: AbortSignal,
  status: (message: string) => void,
) {
  signal.throwIfAborted();
  try {
    await abortable(media.play(), signal);
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
async function playForEncode(
  media: HTMLMediaElement,
  signal: AbortSignal,
  status: (message: string) => void,
) {
  const timeout = AbortSignal.timeout(30_000);
  try {
    await playWithPermission(media, AbortSignal.any([signal, timeout]), status);
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.aborted) throw Error("素材の再生開始がタイムアウトしました。");
    throw error;
  }
}
/** Real-time, on-device encoding. No render job or video upload is created. */
export async function encodeLocal(
  job: LocalEncodeJob,
  audio: AudioContext,
  signal: AbortSignal,
  rest: boolean,
  budget: { processing: number },
  status: (s: string) => void,
  progress: (fraction: number) => void = () => {},
) {
  const mimeType = recorderType();
  if (!mimeType)
    throw Error(
      "このSafariは端末内エンコードに対応していません。対応ブラウザーを使用してください。",
    );
  const duration = job.pieces.reduce(
    (sum, piece) => sum + piece.end - piece.start,
    0,
  );
  const shortJob = duration > 0 && duration <= 10;
  const attempt = (format: string) =>
    encodeLocalAttempt(
      job,
      audio,
      signal,
      rest,
      budget,
      status,
      progress,
      format,
      duration,
    );
  try {
    return await attempt(mimeType);
  } catch (error) {
    if (
      !job.recovery ||
      !shortJob ||
      !(error instanceof Error) ||
      error.name !== "LocalVideoOutputError"
    )
      throw error;
    signal.throwIfAborted();
    const fallback = "video/webm;codecs=vp8,opus";
    status("映像を取り込めなかったため、端末内で一度だけ再試行します。");
    progress(0);
    return await attempt(
      MediaRecorder.isTypeSupported(fallback) ? fallback : mimeType,
    );
  }
}

async function encodeLocalAttempt(
  job: LocalEncodeJob,
  audio: AudioContext,
  signal: AbortSignal,
  rest: boolean,
  budget: { processing: number },
  status: (s: string) => void,
  progress: (fraction: number) => void,
  mimeType: string,
  expectedDuration: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = job.width;
  canvas.height = job.height;
  const ctx = canvas.getContext("2d");
  if (!ctx || !canvas.captureStream)
    throw Error("端末内エンコードに対応していません。");
  // Initialize the bitmap before opening the video track. A restored job
  // has not drawn a composition frame at this point.
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const mediaByKind = new Map<"audio" | "video", HTMLMediaElement>();
  const sources: MediaElementAudioSourceNode[] = [];
  const { stream, recorder } = (() => {
    let destination: MediaStreamAudioDestinationNode | undefined;
    let stream: MediaStream | undefined;
    try {
      destination = audio.createMediaStreamDestination();
      for (const kind of new Set(
        job.pieces.map((piece) => piece.kind ?? "video"),
      )) {
        const media = document.createElement(kind);
        mediaByKind.set(kind, media);
        media.crossOrigin = "anonymous";
        if (kind === "video") (media as HTMLVideoElement).playsInline = true;
        // Muting would also silence the recording destination.
        media.muted = false;
        media.preload = "auto";
        media.style.cssText =
          "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
        document.body.append(media);
        const source = audio.createMediaElementSource(media);
        sources.push(source);
        source.connect(destination);
      }
      // Use a single native capture cadence. Explicit requestFrame calls
      // combined with a capture timer can duplicate timestamps at cuts.
      stream = canvas.captureStream(60);
      const audioTracks = destination.stream.getAudioTracks();
      if (!audioTracks.some((track) => track.readyState === "live"))
        throw Error("録画用の音声トラックを作成できません。");
      audioTracks.forEach((track) => stream!.addTrack(track));
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 320_000,
      });
      return { stream, recorder };
    } catch (error) {
      sources.forEach((source) => source.disconnect());
      mediaByKind.forEach((media) => media.remove());
      stream?.getTracks().forEach((track) => track.stop());
      destination?.stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  })();
  const drawFrame = (
    kind: "audio" | "video",
    media: HTMLMediaElement,
    seconds: number,
  ) => {
    if (kind === "audio") job.drawAudio?.(ctx, seconds);
    else job.draw(ctx, media as HTMLVideoElement, seconds);
  };
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  let recordError: Error | null = null;
  recorder.onerror = () => {
    recordError = Error("端末内エンコードに失敗しました。");
  };
  const total = job.pieces.reduce((n, p) => n + p.end - p.start, 0);
  let recordingStarted = false;
  let elapsed = 0;
  let outputBytes = 0;
  const collect = recorder.ondataavailable;
  recorder.ondataavailable = (event) => {
    if (recordError) return;
    outputBytes += event.data.size;
    if (outputBytes > 256 * 1024 * 1024) {
      recordError = Error(
        "録画データがこの端末内書き出し方式の上限256MiBを超えました。元の素材は保持されています。短い区間を指定して再試行してください。",
      );
      chunks.length = 0;
      if (recorder.state !== "inactive") recorder.stop();
    } else collect?.call(recorder, event);
  };
  let blob: Blob;
  try {
    for (const [index, piece] of job.pieces.entries()) {
      const kind = piece.kind ?? "video";
      const media = mediaByKind.get(kind)!;
      signal.throwIfAborted();
      const url = await piece.url();
      signal.throwIfAborted();
      await mediaReady(
        media,
        ["loadedmetadata", "durationchange"],
        () => media.readyState >= 1,
        signal,
        "素材のメタデータの読み込みがタイムアウトしました。",
        () => {
          media.src = url;
          media.load();
        },
      );
      if (audio.state !== "running")
        throw Error(
          "録画用の音声処理が停止しています。音声処理を許可してください。",
        );
      // Warm up playback, then hold the source at the requested start.
      // Starting the recorder while the source is already running loses the
      // beginning of short clips when the native encoder opens slowly.
      await playForEncode(media, signal, status);
      media.pause();
      if (Math.abs(media.currentTime - piece.start) > 0.001) {
        await mediaReady(
          media,
          ["seeked"],
          () =>
            !media.seeking && Math.abs(media.currentTime - piece.start) <= 0.05,
          signal,
          "指定した再生位置への移動がタイムアウトしました。",
          () => {
            media.currentTime = piece.start;
          },
        );
      }
      if (kind === "video") {
        const video = media as HTMLVideoElement;
        await mediaReady(
          video,
          ["loadeddata", "canplay", "playing", "timeupdate", "resize"],
          () =>
            video.readyState >= 2 &&
            video.videoWidth > 0 &&
            video.videoHeight > 0,
          signal,
          "映像フレームの読み込みがタイムアウトしました。",
        );
      }
      drawFrame(kind, media, elapsed);
      await transitionRecorder(
        recorder,
        recordingStarted ? "resume" : "start",
        signal,
      );
      recordingStarted = true;
      await playForEncode(media, signal, status);
      drawFrame(kind, media, elapsed);
      let last = media.currentTime,
        stalled = performance.now();
      while (media.currentTime < piece.end - 1 / 120) {
        signal.throwIfAborted();
        if (recordError) throw recordError;
        if (recorder.state !== "recording")
          throw Error("録画が途中で停止しました。");
        if ((audio.state as AudioContextState) !== "running")
          throw Error(
            "録画中に音声処理が停止しました。端末を前面に保って再試行してください。",
          );
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
        if (delta > 0) drawFrame(kind, media, elapsed + current - piece.start);
        last = current;
        if (rest && budget.processing >= 600) {
          media.pause();
          await transitionRecorder(recorder, "pause", signal);
          status("4分休憩中（処理と録画を停止しています）");
          await wait(240_000, signal);
          budget.processing = 0;
          if ((audio.state as AudioContextState) !== "running") {
            const timeout = AbortSignal.timeout(30_000);
            try {
              await abortable(
                audio.resume(),
                AbortSignal.any([signal, timeout]),
              );
            } catch (error) {
              signal.throwIfAborted();
              if (timeout.aborted)
                throw Error("音声処理の再開がタイムアウトしました。");
              throw error;
            }
          }
          if ((audio.state as AudioContextState) !== "running")
            throw Error(
              "音声処理を再開できません。端末を前面に保って再試行してください。",
            );
          await transitionRecorder(recorder, "resume", signal);
          await playForEncode(media, signal, status);
          drawFrame(kind, media, elapsed + media.currentTime - piece.start);
          stalled = performance.now();
        }
        progress((elapsed + current - piece.start) / total);
        status(
          `端末内で処理中：${Math.floor(elapsed + current - piece.start)}秒`,
        );
        await wait(16, signal);
      }
      media.pause();
      if (recordError) throw recordError;
      if (index + 1 < job.pieces.length)
        await transitionRecorder(recorder, "pause", signal);
      elapsed += piece.end - piece.start;
    }
    signal.throwIfAborted();
    await transitionRecorder(recorder, "stop", signal);
    signal.throwIfAborted();
    if (recordError) throw recordError;
    blob = new Blob(chunks, { type: mimeType });
  } finally {
    recorder.ondataavailable = recorder.onerror = null;
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } finally {
      chunks.length = 0;
      canvas.width = canvas.height = 0;
      mediaByKind.forEach((media) => {
        media.pause();
        media.removeAttribute("src");
        media.load();
        media.remove();
      });
      sources.forEach((source) => source.disconnect());
      stream.getTracks().forEach((track) => track.stop());
    }
  }
  await validateLocalOutput(blob, signal, expectedDuration);
  return {
    blob,
    filename:
      job.filename.replace(/\.(mp4|webm)$/i, "") +
      (mimeType.startsWith("video/mp4") ? ".mp4" : ".webm"),
  };
}
