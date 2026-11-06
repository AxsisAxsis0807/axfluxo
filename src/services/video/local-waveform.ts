import type { Waveform } from "../../domain/video/preview";

export type WaveformResult = {
  waveform?: Waveform;
  analyzedUntilUs: number;
  progress: number;
  status: "queued" | "analyzing" | "complete" | "no-audio";
};
const MAX_BINS = 20_000;
const MAX_PACKET_BYTES = 4 * 1024 * 1024;

/** Bounded peak storage; timestamps are always in source-media seconds. */
export class PeakAccumulator {
  readonly step: number;
  readonly peaks: number[];
  constructor(
    readonly duration: number,
    step = 0.02,
  ) {
    this.step = Math.max(step, duration / MAX_BINS);
    this.peaks = Array(Math.ceil(duration / this.step) * 2).fill(0);
  }
  add(
    channels: readonly Float32Array[],
    sampleRate: number,
    timestamp: number,
    from = 0,
    until = this.duration,
  ) {
    for (const channel of channels) {
      const first = Math.max(
        0,
        Math.ceil((Math.max(0, from) - timestamp) * sampleRate),
      );
      const last = Math.min(
        channel.length,
        Math.ceil((Math.min(this.duration, until) - timestamp) * sampleRate),
      );
      for (let i = first; i < last; i++) {
        const bin =
          Math.floor((timestamp + i / sampleRate) / this.step + 1e-7) * 2;
        if (bin < 0 || bin + 1 >= this.peaks.length) continue;
        const value = Math.max(-1, Math.min(1, channel[i]));
        this.peaks[bin] = Math.min(this.peaks[bin], value);
        this.peaks[bin + 1] = Math.max(this.peaks[bin + 1], value);
      }
    }
  }
}

// One decoder across both tools. An in-flight decodeAudioData cannot be interrupted;
// its slot stays occupied until it settles, even after cancellation.
let tail = Promise.resolve();
async function serial<T>(
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    signal.throwIfAborted();
    return await task();
  } finally {
    release();
  }
}
const yieldUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function analyzeLocalWaveform(
  file: File,
  duration: number,
  signal: AbortSignal,
  update: (result: WaveformResult) => void,
  window?: { start: number; end: number; step: number },
  pcm?: (
    channels: Float32Array[],
    rate: number,
    timestamp: number,
    from: number,
    until: number,
  ) => Promise<void>,
): Promise<WaveformResult> {
  if (!Number.isFinite(duration) || duration <= 0)
    throw Error("INVALID_DURATION");
  const start = Math.max(0, window?.start ?? 0);
  const endTime = Math.min(duration, window?.end ?? duration);
  if (
    ![start, endTime].every(Number.isFinite) ||
    endTime <= start ||
    (window &&
      (!Number.isFinite(window.step) ||
        window.step <= 0 ||
        endTime - start > 30))
  )
    throw Error("INVALID_WINDOW");
  update({ status: "queued", progress: 0, analyzedUntilUs: 0 });
  return serial(signal, async () => {
    const {
      Input,
      BlobSource,
      ALL_FORMATS,
      AudioBufferSink,
      EncodedPacketSink,
      EncodedAudioPacketSource,
      Output,
      BufferTarget,
      Mp4OutputFormat,
      Mp3OutputFormat,
    } = await import("mediabunny");
    signal.throwIfAborted();
    const input = new Input({
      source: new BlobSource(file, {
        maxCacheSize: 2 * 1024 * 1024,
        useStreamReader: false,
      }),
      formats: ALL_FORMATS,
    });
    const abort = () => input.dispose();
    signal.addEventListener("abort", abort, { once: true });
    let context: AudioContext | undefined;
    try {
      const track = await input.getPrimaryAudioTrack();
      signal.throwIfAborted();
      if (!track)
        return { status: "no-audio", progress: 1, analyzedUntilUs: 0 };
      const codec = await track.getCodec();
      const config = await track.getDecoderConfig();
      if (
        !codec ||
        !config ||
        config.numberOfChannels > 8 ||
        config.sampleRate > 96000
      )
        throw Error("UNSUPPORTED_AUDIO");
      // A PCM consumer owns its analysis in a Worker. Do not repeat display
      // peak extraction or allocate unused waveform snapshots on the UI thread.
      const accumulator = pcm
        ? undefined
        : new PeakAccumulator(
            endTime - start,
            window ? Math.max(window.step, 1 / config.sampleRate) : undefined,
          );
      const versionId = crypto.randomUUID();
      let lastPublish = 0;
      let analyzed = start;
      const publish = (until: number, complete = false): WaveformResult => {
        analyzed = Math.min(endTime, Math.max(analyzed, until));
        const result: WaveformResult = {
          status: complete ? "complete" : "analyzing",
          progress: complete ? 1 : (analyzed - start) / (endTime - start),
          analyzedUntilUs: Math.round(analyzed * 1e6),
          waveform: accumulator
            ? {
                schemaVersion: 1,
                versionId,
                hash: "a".repeat(64),
                originUs: Math.round(start * 1e6),
                sampleRate: config.sampleRate,
                levels: [
                  {
                    stepUs: accumulator.step * 1e6,
                    peaks: accumulator.peaks.slice(),
                  },
                ],
              }
            : undefined,
        };
        if (complete || performance.now() - lastPublish > 200) {
          signal.throwIfAborted();
          update(result);
          lastPublish = performance.now();
        }
        return result;
      };
      const consume = async (
        buffer: AudioBuffer,
        timestamp: number,
        from?: number,
        until?: number,
      ) => {
        const channels = Array.from(
          { length: buffer.numberOfChannels },
          (_, i) => buffer.getChannelData(i),
        );
        await pcm?.(
          channels,
          buffer.sampleRate,
          timestamp,
          Math.max(start, from ?? start),
          Math.min(endTime, until ?? endTime),
        );
        accumulator?.add(
          channels,
          buffer.sampleRate,
          timestamp - start,
          Math.max(start, from ?? start) - start,
          Math.min(endTime, until ?? endTime) - start,
        );
      };
      update({ status: "analyzing", progress: 0, analyzedUntilUs: 0 });
      if (codec.startsWith("pcm-")) {
        // The library's PCM decoder does not require WebCodecs (including Safari).
        for await (const { buffer, timestamp } of new AudioBufferSink(
          track,
        ).buffers(start, endTime)) {
          signal.throwIfAborted();
          await consume(buffer, timestamp);
          publish(timestamp + buffer.duration);
          await yieldUI();
        }
      } else if (codec === "aac" || codec === "mp3") {
        context = new AudioContext({
          sampleRate: config.sampleRate,
        });
        const sink = new EncodedPacketSink(track);
        let packet =
          start > 0
            ? await sink.getPacket(Math.max(0, start - 0.2))
            : await sink.getFirstPacket();
        let overlap: import("mediabunny").EncodedPacket[] = [];
        while (packet && packet.timestamp < endTime) {
          signal.throwIfAborted();
          const freshStart = packet.timestamp;
          const packets = [...overlap];
          let bytes = packets.reduce((n, p) => n + p.data.byteLength, 0);
          const targetEnd = freshStart + 4;
          do {
            signal.throwIfAborted();
            bytes += packet.data.byteLength;
            if (bytes > MAX_PACKET_BYTES || packet.duration > 4)
              throw Error("AUDIO_PACKET_TOO_LARGE");
            packets.push(packet);
            packet = await sink.getNextPacket(packet);
          } while (packet && packet.timestamp < targetEnd);
          const first = packets[0].timestamp;
          const last = packets[packets.length - 1];
          const end = last.timestamp + last.duration;
          if (end - first > 4.5) throw Error("AUDIO_TIMING_UNSUPPORTED");
          const target = new BufferTarget();
          const output = new Output({
            target,
            format:
              codec === "aac"
                ? new Mp4OutputFormat({ fastStart: "in-memory" })
                : new Mp3OutputFormat(),
          });
          const source = new EncodedAudioPacketSource(codec);
          output.addAudioTrack(source);
          try {
            await output.start();
            for (const p of packets) {
              signal.throwIfAborted();
              await source.add(p.clone({ timestamp: p.timestamp - first }), {
                decoderConfig: config,
              });
            }
            await output.finalize();
            signal.throwIfAborted();
            if (
              !target.buffer ||
              target.buffer.byteLength > MAX_PACKET_BYTES + 65536
            )
              throw Error("AUDIO_CHUNK_TOO_LARGE");
            // Only this <=4.2s audio-only chunk is expanded, never the media file.
            const decoded = await context.decodeAudioData(target.buffer);
            signal.throwIfAborted();
            // Refuse codecs/platforms that silently trim or shift chunk durations.
            if (Math.abs(decoded.duration - (end - first)) > 0.06)
              throw Error("AUDIO_TIMING_UNSUPPORTED");
            await consume(decoded, first, freshStart, end);
          } finally {
            if (output.state !== "finalized")
              await output.cancel().catch(() => {});
          }
          overlap = packets.filter((p) => p.timestamp >= end - 0.2);
          publish(end);
          await yieldUI();
        }
      } else {
        // Other codecs use bounded native samples only when this browser can decode them.
        if (!(await track.canDecode())) throw Error("UNSUPPORTED_AUDIO");
        for await (const { buffer, timestamp } of new AudioBufferSink(
          track,
        ).buffers(start, endTime)) {
          signal.throwIfAborted();
          await consume(buffer, timestamp);
          publish(timestamp + buffer.duration);
          await yieldUI();
        }
      }
      signal.throwIfAborted();
      return publish(endTime, true);
    } finally {
      signal.removeEventListener("abort", abort);
      input.dispose();
      await context?.close().catch(() => {});
    }
  });
}
