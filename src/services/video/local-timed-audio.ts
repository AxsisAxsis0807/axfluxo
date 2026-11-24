import { AudioSample, AudioSampleSink, type InputAudioTrack } from "mediabunny";

export const localAudioRate = 48_000;

type AudioBlock = { planes: Float32Array<ArrayBuffer>[]; frames: number };

export type AudioIntervalPlan = {
  rate: number;
  channels: number;
  first: number;
  limit: number;
  decodedEnd: number;
};

/** Only permit a tiny, explicitly accounted-for terminal clock discrepancy.
 * Never tolerate holes within a track, missing PCM, or a substantially short file.
 * A compressed decoder's EOF can differ from the packet/HTML duration.
 */
export function terminalAudioShortfall(
  codec: string | null,
  rate: number,
  first: number,
  limit: number,
  decodedEnd: number,
  packetEnd: number,
  naturalEnd: number | undefined,
) {
  if (decodedEnd === limit && decodedEnd > first) return 0;
  const missing = limit - decodedEnd;
  const bound = codec === "mp3" ? 2304 : codec === "aac" ? 2048 : 0;
  const fullEnd = naturalEnd !== undefined && Number.isFinite(naturalEnd) &&
    Math.abs(Math.round(naturalEnd * rate) - limit) <= 1;
  // A last-frame tolerance is appropriate only at the original track EOF,
  // not for an arbitrary user trim or a missing part of a WAV/PCM source.
  if (
    decodedEnd > first && missing > 0 && bound > 0 &&
    fullEnd && Number.isFinite(packetEnd) &&
    Math.abs(Math.round(packetEnd * rate) - limit) <= bound &&
    missing <= bound && missing / rate <= 0.1
  ) return missing;
  throw Error(
    `指定区間の音声を最後まで読み込めません（指定 ${(limit / rate).toFixed(6)}秒、取得 ${(decodedEnd / rate).toFixed(6)}秒）。終了時刻と素材を確認してください。`,
  );
}

/** Shared strict sample traversal for preflight and the actual encoding pass.
 * Each decoder sample is closed, including on abort, break or consumer error.
 */
async function* sampleSpans(
  track: InputAudioTrack,
  first: number,
  limit: number,
  rate: number,
  channels: number,
  signal: AbortSignal,
) {
  let cursor = first;
  const sink = new AudioSampleSink(track);
  for await (const sample of sink.samples(first / rate, limit / rate)) {
    try {
      signal.throwIfAborted();
      const position = Math.round(sample.timestamp * rate);
      const stop = Math.min(position + sample.numberOfFrames, limit);
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(stop) ||
          sample.sampleRate !== rate || sample.numberOfChannels !== channels)
        throw Error("素材の音声タイムスタンプまたは形式が不正です。");
      if (stop <= cursor) continue;
      if (position > cursor)
        throw Error("素材の音声タイムスタンプに欠落があります。");
      yield { sample, offset: cursor - position, count: stop - cursor, end: stop };
      cursor = stop;
      if (cursor === limit) break;
    } finally {
      sample.close();
    }
  }
  signal.throwIfAborted();
}

/** Decode the selected range before allocating video encoders. No PCM is retained. */
export async function inspectTimedAudio(
  track: InputAudioTrack,
  start: number,
  end: number,
  naturalEnd: number | undefined,
  signal: AbortSignal,
): Promise<AudioIntervalPlan> {
  const [rate, channels] = await Promise.all([
    track.getSampleRate(), track.getNumberOfChannels(),
  ]);
  const first = Math.round(start * rate), limit = Math.round(end * rate);
  if (!Number.isSafeInteger(rate) || rate <= 0 ||
      !Number.isSafeInteger(channels) || channels <= 0 ||
      !Number.isSafeInteger(first) || !Number.isSafeInteger(limit) ||
      first < 0 || limit <= first)
    throw Error("音声区間または音声形式が不正です。");
  let decodedEnd = first;
  for await (const span of sampleSpans(track, first, limit, rate, channels, signal))
    decodedEnd = span.end;
  if (decodedEnd !== limit) {
    const [codec, packetEnd] = await Promise.all([
      track.getCodec(), track.computeDuration(),
    ]);
    terminalAudioShortfall(codec, rate, first, limit, decodedEnd, packetEnd, naturalEnd);
  }
  signal.throwIfAborted();
  return { rate, channels, first, limit, decodedEnd };
}

/** Retain at most a one-second block plus the existing resampling guard.
 * A preflight-proven EOF clock difference is filled only with terminal silence
 * so the existing preview, markers, and exact requested output duration agree.
 */
async function* blocks(
  track: InputAudioTrack,
  plan: AudioIntervalPlan,
  signal: AbortSignal,
) {
  const { first, limit, rate, channels, decodedEnd } = plan;
  let cursor = first;
  const allocate = (): AudioBlock => ({
    planes: Array.from({ length: channels }, () => new Float32Array(rate)),
    frames: 0,
  });
  let block = allocate();
  for await (const span of sampleSpans(track, first, limit, rate, channels, signal)) {
    if (span.end > decodedEnd)
      throw Error("事前検査と書き出し時の音声範囲が一致しません。");
    let copied = 0;
    while (copied < span.count) {
      const count = Math.min(span.count - copied, rate - block.frames);
      block.planes.forEach((plane, index) => {
        span.sample.copyTo(plane.subarray(block.frames, block.frames + count), {
          planeIndex: index,
          format: "f32-planar",
          frameOffset: span.offset + copied,
          frameCount: count,
        });
      });
      copied += count;
      cursor += count;
      block.frames += count;
      if (block.frames === rate) {
        yield block;
        block = allocate();
      }
    }
  }
  if (cursor !== decodedEnd)
    throw Error("事前検査と書き出し時の音声範囲が一致しません。");
  // Only the bounded, previously inspected EOF discrepancy can reach this loop.
  while (cursor < limit) {
    signal.throwIfAborted();
    const count = Math.min(limit - cursor, rate - block.frames);
    block.frames += count;
    cursor += count;
    if (block.frames === rate) {
      yield block;
      block = allocate();
    }
  }
  if (block.frames) yield block;
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

async function normalize(
  block: AudioBlock,
  previous: AudioBlock | undefined,
  next: AudioBlock | undefined,
  rate: number,
  timestamp: number,
  outputFrames: number,
) {
  const channels = block.planes.length;
  if (
    rate === localAudioRate &&
    channels === 2 &&
    block.frames === outputFrames
  ) {
    const data = new Float32Array(outputFrames * 2);
    data.set(block.planes[0].subarray(0, outputFrames));
    data.set(block.planes[1].subarray(0, outputFrames), outputFrames);
    return new AudioSample({
      data,
      format: "f32-planar",
      numberOfChannels: 2,
      sampleRate: localAudioRate,
      timestamp,
    });
  }

  // Keep the resampler's phase at each block boundary and provide neighboring
  // samples for its filter. The overlap is discarded, never added to the audio.
  const period = rate / gcd(rate, localAudioRate);
  const guard = Math.ceil(256 / period) * period;
  const before = previous ? guard : 0;
  const after = next ? Math.min(guard, next.frames) : 0;
  const outputBefore = (before * localAudioRate) / rate;
  const context = new OfflineAudioContext(
    2,
    outputBefore + outputFrames,
    localAudioRate,
  );
  const buffer = context.createBuffer(
    channels,
    before + block.frames + after,
    rate,
  );
  for (let i = 0; i < channels; i++) {
    const plane = buffer.getChannelData(i);
    if (previous)
      plane.set(
        previous.planes[i].subarray(previous.frames - before, previous.frames),
      );
    plane.set(block.planes[i].subarray(0, block.frames), before);
    if (next)
      plane.set(next.planes[i].subarray(0, after), before + block.frames);
  }
  const node = context.createBufferSource();
  node.buffer = buffer;
  node.connect(context.destination);
  node.start();
  const rendered = await context.startRendering();
  const data = new Float32Array(outputFrames * 2);
  for (let i = 0; i < 2; i++)
    data.set(
      rendered.getChannelData(i).subarray(outputBefore),
      i * outputFrames,
    );
  return new AudioSample({
    data,
    format: "f32-planar",
    numberOfChannels: 2,
    sampleRate: localAudioRate,
    timestamp,
  });
}

export async function* timedAudio(
  track: InputAudioTrack,
  plan: AudioIntervalPlan,
  outputStart: number,
  outputEnd: number,
  signal: AbortSignal,
) {
  const { rate, channels } = plan;
  if (await track.getSampleRate() !== rate || await track.getNumberOfChannels() !== channels)
    throw Error("事前検査と書き出し時の音声形式が一致しません。");
  let previous: AudioBlock | undefined;
  let current: AudioBlock | undefined;
  let cursor = outputStart;
  for await (const next of blocks(track, plan, signal)) {
    if (current) {
      yield await normalize(
        current,
        previous,
        next,
        rate,
        cursor / localAudioRate,
        localAudioRate,
      );
      cursor += localAudioRate;
    }
    previous = current;
    current = next;
  }
  if (!current || cursor >= outputEnd)
    throw Error("音声の範囲が短すぎるか、音声サンプルと一致しません。");
  yield await normalize(
    current,
    previous,
    undefined,
    rate,
    cursor / localAudioRate,
    outputEnd - cursor,
  );
}
