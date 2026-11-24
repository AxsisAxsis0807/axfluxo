import {
  AdtsOutputFormat,
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  CanvasSource,
  EncodedAudioPacketSource,
  Input,
  Mp4OutputFormat,
  NullTarget,
  OggOutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import type { LocalEncodeJob } from "./local-encode";
import { inspectTimedAudio, localAudioRate, timedAudio, type AudioIntervalPlan } from "./local-timed-audio";
import { setEncodeReport } from "./local-encode-diagnostics";
import { aacPacketStartSample, localAudioBitrate } from "./local-timed-aac";
import { validateLocalOutput } from "./local-output";

const fps = 60;
const samplesPerFrame = localAudioRate / fps;
const videoBitrate = 8_000_000;
const maxBytes = 256 * 1024 * 1024;

export async function encodeTimedLocal(
  job: LocalEncodeJob,
  signal: AbortSignal,
  status: (message: string) => void,
  progress: (fraction: number) => void,
  pauseIfDue: (duration: number) => Promise<void> | undefined,
) {
  signal.throwIfAborted();
  const videoOptions = {
    width: job.width,
    height: job.height,
    frameRate: fps,
    bitrate: videoBitrate,
    latencyMode: "quality" as const,
  };
  const audioOptions = {
    sampleRate: localAudioRate,
    numberOfChannels: 2,
    bitrate: localAudioBitrate,
  };
  // Prefer the existing Safari-compatible codec pair. Chromium on platforms
  // without an AAC encoder uses the same VP9/Opus MP4 pair as MediaRecorder.
  const codecs = await Promise.all([
    canEncodeVideo("avc", videoOptions),
    canEncodeAudio("aac", audioOptions),
  ]).then(async ([avc, aac]) => {
    if (avc && aac) return ["avc", "aac"] as const;
    const [vp9, opus] = await Promise.all([
      canEncodeVideo("vp9", videoOptions),
      canEncodeAudio("opus", audioOptions),
    ]);
    return vp9 && opus ? (["vp9", "opus"] as const) : null;
  });
  signal.throwIfAborted();
  if (!codecs)
    throw Error(
      "このブラウザーはAll Versionsの同期MP4書き出しに対応していません。",
    );
  setEncodeReport({ state: "running", format: `MP4 (${codecs.join("/")})` });
  const gap = job.gapBetweenPiecesSeconds ?? 0;
  if (!Number.isFinite(gap) || gap < 0)
    throw Error("音源間の無音秒数が不正です。");

  let elapsed = 0;
  const pieces = job.pieces.map((piece, index) => {
    if (index) elapsed += gap;
    const startSample = Math.round(elapsed * localAudioRate);
    elapsed += piece.end - piece.start;
    const endSample = Math.round(elapsed * localAudioRate);
    return { ...piece, startSample, endSample };
  });
  const totalSamples = Math.round(elapsed * localAudioRate);
  const total = totalSamples / localAudioRate;
  if (
    !Number.isFinite(total) ||
    total <= 0 ||
    pieces.some((p) => p.endSample <= p.startSample)
  )
    throw Error("書き出し区間が短すぎるか、時刻が不正です。");

  // Preflight every input before allocating the expensive video encoder.
  // Files/URLs are opened one at a time; no decoded audio is retained.
  const sourceFor = async (piece: (typeof pieces)[number]) =>
    piece.file
      ? new BlobSource(piece.file, { maxCacheSize: 2 * 1024 * 1024 })
      : new UrlSource(await piece.url(), { maxCacheSize: 2 * 1024 * 1024 });
  const plans: AudioIntervalPlan[] = [];
  let tailSeconds = 0;
  for (const [index, piece] of pieces.entries()) {
    signal.throwIfAborted();
    status(`音声範囲の事前検査：${index + 1}/${pieces.length}`);
    const source = await sourceFor(piece);
    signal.throwIfAborted();
    const input = new Input({ source, formats: ALL_FORMATS });
    const abortInput = () => input.dispose();
    signal.addEventListener("abort", abortInput, { once: true });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode()))
        throw Error("このブラウザーで素材の音声をデコードできません。");
      const plan = await inspectTimedAudio(
        track, piece.start, piece.end, piece.sourceDuration, signal,
      );
      plans.push(plan);
      tailSeconds += (plan.limit - plan.decodedEnd) / plan.rate;
    } finally {
      signal.removeEventListener("abort", abortInput);
      input.dispose();
    }
  }
  signal.throwIfAborted();
  if (tailSeconds > 0) {
    setEncodeReport({ state: "running", sourceTailSilenceSeconds: tailSeconds });
    status(`音声末尾の時刻差を補正：${(tailSeconds * 1000).toFixed(2)}ms（指定尺は維持）`);
  }

  const canvas = document.createElement("canvas");
  canvas.width = job.width;
  canvas.height = job.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw Error("Canvasを使用できません。");
  const media = document.createElement("video");
  const chunks: Blob[] = [];
  let bytes = 0;
  const target = new StreamTarget(
    new WritableStream({
      write({ position, data }) {
        const end = position + data.byteLength;
        if (position > bytes || (position < bytes && end > bytes))
          throw Error("MP4の書き込み位置が不正です。");
        if (end > maxBytes)
          throw Error(
            "完成ファイルが安全な保持上限256MiBを超えました。区間を短くしてください。",
          );
        if (position === bytes) {
          chunks.push(new Blob([data]));
          bytes = end;
          return;
        }
        // The regular MP4 muxer seeks back to fill in the mdat box size.
        // Patch only the affected Blob slices instead of copying the movie.
        let offset = 0;
        for (let i = 0; i < chunks.length && offset < end; i++) {
          const original = chunks[i];
          const limit = offset + original.size;
          if (limit > position) {
            const first = Math.max(position, offset);
            const last = Math.min(end, limit);
            chunks[i] = new Blob([
              original.slice(0, first - offset),
              data.subarray(first - position, last - position),
              original.slice(last - offset),
            ]);
          }
          offset = limit;
        }
      },
    }),
    { chunked: true, chunkSize: 1024 * 1024 },
  );
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target,
  });
  const frameCount = Math.ceil(totalSamples / samplesPerFrame);
  const encodedFrames = new Uint8Array(frameCount);
  let videoError = false;
  const video = new CanvasSource(canvas, {
    codec: codecs[0],
    bitrate: videoBitrate,
    latencyMode: "quality",
    onEncodedPacket(packet) {
      const index = Math.round(packet.timestamp * fps);
      if (
        index < 0 ||
        index >= frameCount ||
        encodedFrames[index] ||
        Math.abs(packet.timestamp - index / fps) > 0.000001
      )
        videoError = true;
      else encodedFrames[index] = 1;
    },
  });
  const audioTrack = new EncodedAudioPacketSource(codecs[1]);
  output.addVideoTrack(video);
  output.addAudioTrack(audioTrack);

  // Retain the native encoder's priming metadata. Author the final packet's
  // presentation length before muxing, excluding encoder padding past the PCM.
  // The audio-only target lets Mediabunny manage native priming and backpressure.
  let audioPackets = Promise.resolve();
  let audioError: unknown;
  let nextAacSample = codecs[1] === "aac" ? await aacPacketStartSample() : 0;
  signal.throwIfAborted();
  const audio = new AudioSampleSource({
    codec: codecs[1],
    bitrate: localAudioBitrate,
    onEncodedPacket(packet, metadata) {
      if (codecs[1] === "aac") {
        // AAC-LC access units contain 1024 PCM samples. Some WebKit backends
        // report discontinuous chunk timestamps for consecutive units. Keep
        // the measured stereo priming offset and count decoded samples
        // thereafter, as the audio input already uses a contiguous PCM clock.
        const first = nextAacSample;
        nextAacSample += 1024;
        packet = packet.clone({
          timestamp: first / localAudioRate,
          duration: 1024 / localAudioRate,
        });
      }
      const duration = Math.min(packet.duration, total - packet.timestamp);
      if (duration <= 0) return;
      audioPackets = audioPackets
        .then(() =>
          audioTrack.add(
            duration === packet.duration ? packet : packet.clone({ duration }),
            metadata,
          ),
        )
        .catch((error: unknown) => {
          audioError ??= error;
        });
    },
  });
  const audioEncoder = new Output({
    format:
      codecs[1] === "aac" ? new AdtsOutputFormat() : new OggOutputFormat(),
    target: new NullTarget(),
  });
  audioEncoder.addAudioTrack(audio);

  let frame = 0;
  let audioCursor = 0;
  let activeInput: Input | undefined;
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    activeInput?.dispose();
    cancellation ??= Promise.all([
      output.cancel().catch(() => {}),
      audioEncoder.cancel().catch(() => {}),
    ]).then(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const writeAudio = async (sample: AudioSample) => {
    try {
      await audio.add(sample);
      await audioPackets;
      if (audioError) throw audioError;
      const end =
        Math.round(sample.timestamp * localAudioRate) + sample.numberOfFrames;
      while (frame * samplesPerFrame < end) {
        signal.throwIfAborted();
        const seconds = frame / fps;
        const duration =
          Math.min(samplesPerFrame, totalSamples - frame * samplesPerFrame) /
          localAudioRate;
        job.draw(ctx, media, seconds);
        await video.add(seconds, duration);
        frame++;
        const pause = pauseIfDue(duration);
        if (pause) await pause;
      }
      progress(end / totalSamples);
      status(`端末内で処理中：${Math.floor(end / localAudioRate)}秒`);
    } finally {
      sample.close();
    }
  };

  try {
    signal.throwIfAborted();
    await output.start();
    await audioEncoder.start();
    for (const [index, piece] of pieces.entries()) {
      signal.throwIfAborted();
      // Explicit inter-file gaps only. Markers never split audio pieces.
      while (audioCursor < piece.startSample) {
        const count = Math.min(localAudioRate, piece.startSample - audioCursor);
        await writeAudio(
          new AudioSample({
            data: new Float32Array(count * 2),
            format: "f32",
            numberOfChannels: 2,
            sampleRate: localAudioRate,
            timestamp: audioCursor / localAudioRate,
          }),
        );
        audioCursor += count;
      }
      const source = await sourceFor(piece);
      signal.throwIfAborted();
      const input = new Input({ source, formats: ALL_FORMATS });
      activeInput = input;
      try {
        const track = await input.getPrimaryAudioTrack();
        if (!track || !(await track.canDecode()))
          throw Error("このブラウザーで素材の音声をデコードできません。");
        for await (const sample of timedAudio(
          track,
          plans[index],
          piece.startSample,
          piece.endSample,
          signal,
        )) {
          await writeAudio(sample);
        }
      } finally {
        input.dispose();
        activeInput = undefined;
      }
      audioCursor = piece.endSample;
    }
    signal.throwIfAborted();
    video.close();
    if (codecs[1] === "aac") {
      // Some native AAC encoders retain trailing input on flush. Feed a
      // bounded drain block and discard access units past the presentation end.
      // No drain samples extend the MP4 timeline.
      const drain = new AudioSample({
        data: new Float32Array(8192 * 2),
        format: "f32-planar",
        numberOfChannels: 2,
        sampleRate: localAudioRate,
        timestamp: total,
      });
      try {
        await audio.add(drain);
      } finally {
        drain.close();
      }
    }
    await audioEncoder.finalize();
    await audioPackets;
    if (audioError) throw audioError;
    audioTrack.close();
    await output.finalize();
    if (videoError || encodedFrames.includes(0))
      throw Error("完成動画のフレーム時刻に欠落または重複があります。");
    const blob = new Blob(chunks, { type: "video/mp4" });
    await validateLocalOutput(blob, signal, { duration: total });
    return {
      blob,
      filename: job.filename.replace(/\.(mp4|webm)$/i, "") + ".mp4",
    };
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    if (output.state !== "finalized") {
      abort();
      await cancellation;
    }
    chunks.length = 0;
    canvas.width = canvas.height = 0;
  }
}
