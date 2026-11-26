import {
  encodeFailureCategory,
  setEncodeReport,
} from "./local-encode-diagnostics";
import { validateLocalOutput } from "./local-output";
import type { LocalProjectData } from "./local-project";
export type LocalEncodeJob = {
  recovery?: { project: LocalProjectData; index: number };
  /** For compositions that can be rendered without decoding source video. */
  timestamped?: boolean;
  filename: string;
  width: number;
  height: number;
  /** Record this much silence between consecutive source files; 0 by default. */
  gapBetweenPiecesSeconds?: number;
  pieces: {
    file?: File;
    url: () => Promise<string>;
    start: number;
    end: number;
    /** Original media duration, not a user trim or an inter-file gap. */
    sourceDuration?: number;
  }[];
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
export function usesTimedLocalEncoding(job: LocalEncodeJob) {
  return (
    !!job.timestamped &&
    typeof VideoEncoder !== "undefined" &&
    typeof AudioEncoder !== "undefined" &&
    typeof AudioDecoder !== "undefined" &&
    typeof OfflineAudioContext !== "undefined"
  );
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
async function playForEncode(
  media: HTMLVideoElement,
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
/** On-device encoding. No server render job or media upload is created. */
export async function encodeLocal(
  job: LocalEncodeJob,
  audio: AudioContext | undefined,
  signal: AbortSignal,
  rest: boolean,
  budget: { processing: number },
  status: (s: string) => void,
  progress: (fraction: number) => void = () => {},
) {
  const timed = usesTimedLocalEncoding(job);
  if (job.timestamped)
    setEncodeReport({
      route: timed ? "WebCodecs" : "MediaRecorder",
      format: timed ? undefined : (recorderType() ?? undefined),
      state: "running",
    });
  try {
    let result;
    if (timed) {
      const { encodeTimedLocal } = await import("./local-timed-encode");
      result = await encodeTimedLocal(
        job,
        signal,
        status,
        progress,
        (duration) => {
          budget.processing += duration;
          if (!rest || budget.processing < 600) return;
          status("4分休憩中（処理と録画を停止しています）");
          return wait(240_000, signal).then(() => {
            budget.processing = 0;
          });
        },
      );
    } else
      result = await recordLocal(
        job,
        audio,
        signal,
        rest,
        budget,
        status,
        progress,
      );
    if (job.timestamped) setEncodeReport({ state: "complete" });
    return result;
  } catch (error) {
    if (job.timestamped)
      setEncodeReport({
        state: "failed",
        failure: encodeFailureCategory(error),
      });
    throw error;
  }
}

async function recordLocal(
  job: LocalEncodeJob,
  audio: AudioContext | undefined,
  signal: AbortSignal,
  rest: boolean,
  budget: { processing: number },
  status: (s: string) => void,
  progress: (fraction: number) => void,
) {
  const gap = job.gapBetweenPiecesSeconds ?? 0;
  if (!Number.isFinite(gap) || gap < 0)
    throw Error("音源間の無音秒数が不正です。");
  const mimeType = recorderType();
  if (!audio || !mimeType)
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
  const { source, stream, recorder } = (() => {
    let source: MediaElementAudioSourceNode | undefined;
    let destination: MediaStreamAudioDestinationNode | undefined;
    let stream: MediaStream | undefined;
    try {
      destination = audio.createMediaStreamDestination();
      source = audio.createMediaElementSource(media);
      source.connect(destination);
      stream = canvas.captureStream(60);
      destination.stream.getAudioTracks().forEach((t) => stream!.addTrack(t));
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 320_000,
      });
      return { source, stream, recorder };
    } catch (error) {
      source?.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
      destination?.stream.getTracks().forEach((t) => t.stop());
      media.remove();
      throw error;
    }
  })();
  const drawFrame = (seconds: number) => {
    job.draw(ctx, media, seconds);
    // Some engines drop the pre-start frame while the recorder is paused.
    // Explicitly request a fresh frame after resume, including static artwork.
    const track = stream.getVideoTracks()[0] as
      CanvasCaptureMediaStreamTrack | undefined;
    track?.requestFrame?.();
  };
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
  const total = job.pieces.reduce((n, p) => n + p.end - p.start, 0) +
    Math.max(0, job.pieces.length - 1) * gap;
  let recordingStarted = false;
  let elapsed = 0;
  let outputBytes = 0;
  const collect = recorder.ondataavailable;
  recorder.ondataavailable = (event) => {
    outputBytes += event.data.size;
    if (outputBytes > 256 * 1024 * 1024) {
      recordError = Error(
        "完成ファイルが安全な保持上限256MiBを超えました。区間を短くしてください。",
      );
      if (recorder.state !== "inactive") recorder.stop();
    } else collect?.call(recorder, event);
  };
  try {
    for (const [index, piece] of job.pieces.entries()) {
      signal.throwIfAborted();
      // Keep the existing recorder and audio graph running during the explicit
      // inter-file silence. Do not include source loading time in the gap.
      if (index && gap) {
        recorder.resume();
        const started = performance.now();
        for (;;) {
          signal.throwIfAborted();
          if (recordError) throw recordError;
          const seconds = Math.min(gap, (performance.now() - started) / 1000);
          drawFrame(elapsed + seconds);
          progress((elapsed + seconds) / total);
          if (seconds >= gap) break;
          await wait(Math.min(16, (gap - seconds) * 1000), signal);
        }
        recorder.pause();
        elapsed += gap;
        budget.processing += gap;
      }
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
      drawFrame(elapsed);
      if (recorder.state === "inactive") {
        recorder.start(1000);
        recordingStarted = true;
        recorder.pause();
      }
      await playForEncode(media, signal, status);
      recorder.resume();
      drawFrame(elapsed);
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
        drawFrame(elapsed + current - piece.start);
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
        progress((elapsed + current - piece.start) / total);
        status(
          `端末内で処理中：${Math.floor(elapsed + current - piece.start)}秒`,
        );
        await wait(16, signal);
      }
      media.pause();
      recorder.pause();
      elapsed += piece.end - piece.start;
    }
    signal.throwIfAborted();
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    signal.throwIfAborted();
    if (recordError) throw recordError;
    const blob = new Blob(chunks, { type: mimeType });
    await validateLocalOutput(
      blob,
      signal,
      job.timestamped
        ? {
            duration: total,
            legacyRecorder: true,
          }
        : undefined,
    );
    return {
      blob,
      filename:
        job.filename.replace(/\.(mp4|webm)$/i, "") +
        (mimeType.startsWith("video/mp4") ? ".mp4" : ".webm"),
    };
  } finally {
    if (recorder.state !== "inactive") recorder.stop();
    media.pause();
    if (recordingStarted) await stopped;
    media.removeAttribute("src");
    media.load();
    media.remove();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
  }
}
