import { AudioSample, AudioSampleSink, EncodedPacketSink, type InputAudioTrack } from "mediabunny";

export const localAudioRate = 48_000;

type AudioBlock = { planes: Float32Array<ArrayBuffer>[]; frames: number };

export type AudioIntervalPlan = {
  rate: number;
  channels: number;
  first: number;
  limit: number;
  decodedEnd: number;
  decoder?: "webaudio";
  packetEnd?: number;
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

/** Long native MP3 decoding through AudioDecoder has crashed Linux WebKit.
 * Use Web Audio for local, bounded MP3 files on WebKit, without changing
 * Chromium's streaming route or allocating an unbounded decoded buffer.
 */
export const webAudioMp3Budget = 96 * 1024 * 1024;
export function prefersWebAudioMp3(userAgent: string, duration: number) {
  const webkit = /AppleWebKit\//.test(userAgent) &&
    (/iPhone|iPad|iPod/.test(userAgent) || !/Chrome\/|Chromium\/|Edg\//.test(userAgent));
  return webkit && duration > 8;
}
export function fitsWebAudioMp3Budget(duration: number, rate: number, channels: number, fileBytes: number) {
  const bytes = Math.ceil(duration * rate + 2304) * channels * 4 + fileBytes;
  return Number.isFinite(bytes) && bytes > 0 && bytes <= webAudioMp3Budget;
}

/** Independently verify the compressed track clock before Web Audio decode.
 * This does not claim that a decoder can detect every corrupted MP3 bit.
 */
async function inspectMp3Packets(track: InputAudioTrack, rate: number, signal: AbortSignal) {
  let previous: number | undefined;
  for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
    signal.throwIfAborted();
    const first = Math.round(packet.timestamp * rate);
    const end = Math.round((packet.timestamp + packet.duration) * rate);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(end) || end <= first ||
        (previous !== undefined && Math.abs(first - previous) > 1))
      throw Error("素材のMP3パケット時刻に欠落または重複があります。");
    previous = end;
  }
  if (previous === undefined || previous <= 0) throw Error("MP3の音声データがありません。");
  return previous / rate;
}

async function decodeWebAudioMp3(file: Blob, rate: number, channels: number, packetEnd: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!fitsWebAudioMp3Budget(packetEnd, rate, channels, file.size))
    throw Error("MP3の音声展開が端末の安全なメモリ範囲を超えます。");
  // Use the source sample rate, not the device's audio output clock.
  const context = new OfflineAudioContext(channels, 1, rate);
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const buffer = await context.decodeAudioData(bytes);
  signal.throwIfAborted();
  if (buffer.sampleRate !== rate || buffer.numberOfChannels !== channels ||
      !Number.isSafeInteger(buffer.length) || buffer.length <= 0 ||
      Math.abs(buffer.length - Math.round(packetEnd * rate)) > 2304 ||
      !fitsWebAudioMp3Budget(buffer.duration, rate, channels, file.size))
    throw Error("MP3の音声展開結果が素材の形式または時刻と一致しません。");
  return buffer;
}

async function* webAudioSpans(file: Blob, plan: AudioIntervalPlan, signal: AbortSignal) {
  const { rate, channels, first, limit, decodedEnd, packetEnd } = plan;
  if (packetEnd === undefined) throw Error("MP3事前検査の時刻がありません。");
  const buffer = await decodeWebAudioMp3(file, rate, channels, packetEnd, signal);
  if (Math.min(buffer.length, limit) !== decodedEnd)
    throw Error("事前検査と書き出し時の音声範囲が一致しません。");
  for (let position = first; position < decodedEnd;) {
    signal.throwIfAborted();
    const count = Math.min(rate, decodedEnd - position);
    const data = new Float32Array(count * channels);
    for (let channel = 0; channel < channels; channel++)
      data.set(buffer.getChannelData(channel).subarray(position, position + count), channel * count);
    const sample = new AudioSample({ data, format: "f32-planar", sampleRate: rate, numberOfChannels: channels, timestamp: position / rate });
    try {
      yield { sample, offset: 0, count, end: position + count };
    } finally { sample.close(); }
    position += count;
  }
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
  // Bound long MP3 decoder sessions. Mediabunny seeks with codec pre-roll,
  // and every intermediate window must cover its exact sample range.
  const codec = await track.getCodec();
  const windowFrames = codec === "mp3" ? rate * 8 : limit - first;
  for (let windowStart = first; windowStart < limit; windowStart += windowFrames) {
    const windowEnd = Math.min(limit, windowStart + windowFrames);
    const sink = new AudioSampleSink(track);
    let decodedPackets = 0;
    for await (const sample of sink.samples(windowStart / rate, windowEnd / rate)) {
      try {
        signal.throwIfAborted();
        const position = Math.round(sample.timestamp * rate);
        const stop = Math.min(position + sample.numberOfFrames, windowEnd);
        if (!Number.isSafeInteger(position) || !Number.isSafeInteger(stop) ||
            !Number.isSafeInteger(sample.numberOfFrames) || sample.numberOfFrames <= 0 ||
            sample.sampleRate !== rate || sample.numberOfChannels !== channels)
          throw Error("素材の音声タイムスタンプまたは形式が不正です。");
        if (stop <= cursor) continue;
        if (position > cursor)
          throw Error("素材の音声タイムスタンプに欠落があります。");
        yield { sample, offset: cursor - position, count: stop - cursor, end: stop };
        cursor = stop;
      } finally {
        sample.close();
      }
      // Yield to native decoder cleanup and browser event processing regularly.
      if (++decodedPackets % 32 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    if (windowEnd < limit && cursor !== windowEnd)
      throw Error("素材の音声タイムスタンプに欠落があります。");
    // Drain the iterator naturally before creating the next decoder.
    if (windowEnd < limit) await new Promise<void>(resolve => setTimeout(resolve, 0));
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
  file?: Blob,
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
  const codec = await track.getCodec();
  // A long local WebKit MP3 uses a separate decoder implementation.
  // Above the budget retain the previous bounded streaming path.
  if (file && codec === "mp3" && typeof OfflineAudioContext !== "undefined" &&
      typeof navigator !== "undefined" && prefersWebAudioMp3(navigator.userAgent, naturalEnd ?? end)) {
    const packetEnd = await inspectMp3Packets(track, rate, signal);
    if (fitsWebAudioMp3Budget(Math.max(packetEnd, naturalEnd ?? end), rate, channels, file.size)) {
      const buffer = await decodeWebAudioMp3(file, rate, channels, packetEnd, signal);
      const decodedEnd = Math.min(buffer.length, limit);
      terminalAudioShortfall(codec, rate, first, limit, decodedEnd, packetEnd, naturalEnd);
      return { rate, channels, first, limit, decodedEnd, decoder: "webaudio", packetEnd };
    }
  }
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
  file?: Blob,
) {
  const { first, limit, rate, channels, decodedEnd } = plan;
  let cursor = first;
  const allocate = (): AudioBlock => ({
    planes: Array.from({ length: channels }, () => new Float32Array(rate)),
    frames: 0,
  });
  let block = allocate();
  if (plan.decoder === "webaudio" && !file) throw Error("MP3の元ファイルを再選択してください。");
  const spans = plan.decoder === "webaudio"
    ? webAudioSpans(file!, plan, signal)
    : sampleSpans(track, first, limit, rate, channels, signal);
  for await (const span of spans) {
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
  file?: Blob,
) {
  const { rate, channels } = plan;
  if (await track.getSampleRate() !== rate || await track.getNumberOfChannels() !== channels)
    throw Error("事前検査と書き出し時の音声形式が一致しません。");
  let previous: AudioBlock | undefined;
  let current: AudioBlock | undefined;
  let cursor = outputStart;
  for await (const next of blocks(track, plan, signal, file)) {
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
