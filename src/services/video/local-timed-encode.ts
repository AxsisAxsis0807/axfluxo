import {
  AdtsOutputFormat,
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  VideoSample,
  VideoSampleSource,
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
import { audioFadeGain, type LocalEncodeJob } from "./local-encode";
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
  status("書き出し形式を確認中…");
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
      ? new BlobSource(piece.file, { maxCacheSize: 2 * 1024 * 1024, useStreamReader: false })
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
      if (!track) throw Error("素材に音声トラックがありません。");
      const plan = await inspectTimedAudio(
        track, piece.start, piece.end, piece.sourceDuration, signal, piece.file,
      );
      plans.push(plan);
      status(`音声範囲の事前検査完了：${index + 1}/${pieces.length}（${plan.decoder === "webaudio" ? "Web Audio" : "WebCodecs"}）`);
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

  status("音声エンコーダーの時刻を確認中…");
  let nextAacSample = codecs[1] === "aac" ? await aacPacketStartSample() : 0;
  signal.throwIfAborted();
  const createCanvas = (readback: boolean) => {
    const element = document.createElement("canvas");
    element.width = job.width;
    element.height = job.height;
    const context = element.getContext("2d", {
      alpha: false,
      willReadFrequently: readback,
    });
    if (!context) {
      element.width = element.height = 0;
      throw Error("Canvasを使用できません。");
    }
    return { element, context };
  };
  let { element: canvas, context: ctx } = createCanvas(false);
  let pixelReadback = false;
  let pieceIndex = 0;
  let stage = "setup";
  let frameAddMs = 0;
  let frameAddMaxMs = 0;
  const started = performance.now();
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
  const video = new VideoSampleSource({
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
  let audioWrittenEnd = 0;
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
    const end =
      Math.round(sample.timestamp * localAudioRate) + sample.numberOfFrames;
    let faded: AudioSample | undefined;
    try {
      stage = "audio-add";
      const fade = job.audioFadeOutSeconds;
      if (fade && end / localAudioRate > total - fade) {
        const frames = sample.numberOfFrames;
        const data = new Float32Array(frames * 2);
        for (let channel = 0; channel < 2; channel++) {
          sample.copyTo(data.subarray(channel * frames, (channel + 1) * frames), {
            planeIndex: channel,
            format: "f32-planar",
          });
        }
        for (let i = 0; i < frames; i++) {
          const gain = audioFadeGain(
            total - sample.timestamp - i / localAudioRate,
            fade,
          );
          data[i] *= gain;
          data[frames + i] *= gain;
        }
        faded = new AudioSample({
          data,
          format: "f32-planar",
          numberOfChannels: 2,
          sampleRate: localAudioRate,
          timestamp: sample.timestamp,
        });
      }
      await audio.add(faded ?? sample);
    } finally {
      faded?.close();
      sample.close();
    }
    await audioPackets;
    if (audioError) throw audioError;
    audioWrittenEnd = end;
    while (frame * samplesPerFrame < end) {
      signal.throwIfAborted();
      const seconds = frame / fps;
      const duration =
        Math.min(samplesPerFrame, totalSamples - frame * samplesPerFrame) /
        localAudioRate;
      stage = "draw";
      if (ctx.isContextLost?.()) throw Error("Canvas context lost");
      job.draw(ctx, media, seconds);
      stage = "capture";
      let captured: VideoSample;
      if (!pixelReadback) {
        try {
          captured = new VideoSample(canvas, { timestamp: seconds, duration });
        } catch (error) {
          // Recover only before any sample reaches the encoder. Recreate the
          // backing store and draw the exact same timeline position.
          if (!(error instanceof Error) || error.name !== "InvalidStateError" ||
              !/Canvas has no frame/i.test(error.message)) throw error;
          signal.throwIfAborted();
          const previous = canvas;
          const replacement = createCanvas(true);
          canvas = replacement.element;
          ctx = replacement.context;
          previous.width = previous.height = 0;
          pixelReadback = true;
          console.info("[AxFluxo] canvas capture switched to pixel readback", {
            piece: pieceIndex + 1, frame, fps, bytes, chunks: chunks.length,
          });
          if (ctx.isContextLost?.()) throw Error("Canvas context lost");
          job.draw(ctx, media, seconds);
          captured = new VideoSample(
            ctx.getImageData(0, 0, job.width, job.height).data,
            { format: "RGBX", codedWidth: job.width, codedHeight: job.height,
              timestamp: seconds, duration },
          );
        }
      } else {
        captured = new VideoSample(
          ctx.getImageData(0, 0, job.width, job.height).data,
          { format: "RGBX", codedWidth: job.width, codedHeight: job.height,
            timestamp: seconds, duration },
        );
      }
      try {
        signal.throwIfAborted();
        if (ctx.isContextLost?.()) throw Error("Canvas context lost");
        stage = "video-add";
        const startAdd = performance.now();
        await video.add(captured);
        frameAddMs = performance.now() - startAdd;
        frameAddMaxMs = Math.max(frameAddMaxMs, frameAddMs);
      } finally {
        captured.close();
      }
      frame++;
      const pause = pauseIfDue(duration);
      if (pause) await pause;
    }
    progress(end / totalSamples);
    status(`端末内で処理中：${Math.floor(end / localAudioRate)}秒`);
  };

  try {
    signal.throwIfAborted();
    status("MP4エンコーダーを準備中…");
    await output.start();
    await audioEncoder.start();
    for (const [index, piece] of pieces.entries()) {
      pieceIndex = index;
      stage = "piece";
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
        if (!track) throw Error("素材に音声トラックがありません。");
        status(`音声・映像の書き出し開始：${index + 1}/${pieces.length}`);
        for await (const sample of timedAudio(
          track,
          plans[index],
          piece.startSample,
          piece.endSample,
          signal,
          piece.file,
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
    stage = "finalize";
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
    status("音声エンコーダーを終了中…");
    await audioEncoder.finalize();
    await audioPackets;
    if (audioError) throw audioError;
    audioTrack.close();
    status("MP4を確定中…");
    await output.finalize();
    if (videoError || encodedFrames.includes(0))
      throw Error("完成動画のフレーム時刻に欠落または重複があります。");
    const blob = new Blob(chunks, { type: "video/mp4" });
    chunks.length = 0;
    canvas.width = canvas.height = 0;
    stage = "validate";
    status("完成MP4の音声と映像を検査中…");
    await validateLocalOutput(blob, signal, { duration: total });
    return {
      blob,
      filename: job.filename.replace(/\.(mp4|webm)$/i, "") + ".mp4",
      note: tailSeconds > 0
        ? `音声末尾の時刻差 ${(tailSeconds * 1000).toFixed(2)}ms を無音で補正（指定尺を維持）`
        : undefined,
    };
  } catch (error) {
    signal.throwIfAborted();
    const details = {
      stage, piece: pieceIndex + 1, pieces: pieces.length,
      frame, fps, seconds: frame / fps, audioCursor, audioWrittenEnd, totalSamples,
      width: canvas.width, height: canvas.height, bytes,
      chunks: chunks.length, pixelReadback,
      decoder: plans[pieceIndex]?.decoder ?? "streaming",
      frameAddMs: Math.round(frameAddMs), frameAddMaxMs: Math.round(frameAddMaxMs),
      elapsedMs: Math.round(performance.now() - started),
      visibility: document.visibilityState,
    };
    console.error("[AxFluxo] timed export failed", details, error);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason} [${stage}; piece ${pieceIndex + 1}/${pieces.length}; frame ${frame}; ${fps}fps; ${bytes} bytes; ${pixelReadback ? "pixels" : "canvas"}]`, { cause: error });
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
