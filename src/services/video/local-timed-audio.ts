import { AudioSample, AudioSampleSink, type InputAudioTrack } from "mediabunny";

export const localAudioRate = 48_000;

type AudioBlock = { planes: Float32Array<ArrayBuffer>[]; frames: number };

/** Decode only the requested interval, retaining at most one second per block. */
async function* blocks(
  track: InputAudioTrack,
  start: number,
  end: number,
  rate: number,
  channels: number,
  signal: AbortSignal,
) {
  const first = Math.round(start * rate);
  const limit = Math.round(end * rate);
  let cursor = first;
  const allocate = (): AudioBlock => ({
    planes: Array.from({ length: channels }, () => new Float32Array(rate)),
    frames: 0,
  });
  let block = allocate();
  const sink = new AudioSampleSink(track);
  // The sink includes the sample overlapping the start of an in-packet trim.
  for await (const sample of sink.samples(start, end)) {
    try {
      signal.throwIfAborted();
      const position = Math.round(sample.timestamp * rate);
      const stop = Math.min(position + sample.numberOfFrames, limit);
      if (stop <= cursor) continue;
      if (
        position > cursor ||
        sample.sampleRate !== rate ||
        sample.numberOfChannels !== channels
      )
        throw Error(
          "素材の音声タイムスタンプに欠落または形式の変更があります。",
        );
      while (cursor < stop) {
        const count = Math.min(stop - cursor, rate - block.frames);
        block.planes.forEach((plane, index) => {
          sample.copyTo(plane.subarray(block.frames, block.frames + count), {
            planeIndex: index,
            format: "f32-planar",
            frameOffset: cursor - position,
            frameCount: count,
          });
        });
        cursor += count;
        block.frames += count;
        if (block.frames === rate) {
          yield block;
          block = allocate();
        }
      }
      if (cursor === limit) break;
    } finally {
      sample.close();
    }
  }
  if (cursor !== limit)
    throw Error(
      "指定区間の音声を最後まで読み込めません。終了時刻を確認してください。",
    );
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
  start: number,
  end: number,
  outputStart: number,
  outputEnd: number,
  signal: AbortSignal,
) {
  const [rate, channels] = await Promise.all([
    track.getSampleRate(),
    track.getNumberOfChannels(),
  ]);
  let previous: AudioBlock | undefined;
  let current: AudioBlock | undefined;
  let cursor = outputStart;
  for await (const next of blocks(track, start, end, rate, channels, signal)) {
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
