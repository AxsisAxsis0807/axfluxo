import {
  AdtsOutputFormat,
  AudioSample,
  AudioSampleSource,
  NullTarget,
  Output,
  type EncodedPacket,
} from "mediabunny";
import { localAudioRate } from "./local-timed-audio";

export const localAudioBitrate = 320_000;
let calibration: Promise<number> | undefined;

export function aacPacketStartSample() {
  return (calibration ??= calibrate().catch((error: unknown) => {
    calibration = undefined;
    throw error;
  }));
}

/** Calibrate the actual stereo encoder, independent of native chunk timestamps. */
async function calibrate() {
  const impulse = 4096;
  const frames = 8192;
  const data = new Float32Array(frames * 2);
  data[impulse] = data[frames + impulse] = 1;
  const packets: EncodedPacket[] = [];
  let config: AudioDecoderConfig | undefined;
  const encoder = new AudioSampleSource({
    codec: "aac",
    bitrate: localAudioBitrate,
    onEncodedPacket(packet, metadata) {
      config ??= metadata?.decoderConfig;
      packets.push(packet);
    },
  });
  const output = new Output({
    format: new AdtsOutputFormat(),
    target: new NullTarget(),
  });
  output.addAudioTrack(encoder);
  const sample = new AudioSample({
    data,
    format: "f32-planar",
    sampleRate: localAudioRate,
    numberOfChannels: 2,
    timestamp: 0,
  });
  try {
    await output.start();
    await encoder.add(sample);
    await output.finalize();
  } finally {
    sample.close();
    if (output.state !== "finalized") await output.cancel();
  }
  if (!config || !packets.length)
    throw Error("AACの音声時刻を確認できません。");

  let cursor = 0;
  let peakAt = -1;
  let peak = 0;
  let failure: DOMException | undefined;
  const decoder = new AudioDecoder({
    output(block) {
      try {
        const pcm = new Float32Array(block.numberOfFrames);
        block.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
        for (let i = 0; i < pcm.length; i++) {
          if (Math.abs(pcm[i]) <= peak) continue;
          peak = Math.abs(pcm[i]);
          peakAt = cursor + i;
        }
        cursor += pcm.length;
      } finally {
        block.close();
      }
    },
    error(error) {
      failure = error;
    },
  });
  try {
    decoder.configure(config);
    for (const packet of packets) decoder.decode(packet.toEncodedAudioChunk());
    await decoder.flush();
    if (failure) throw failure;
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
  const firstSample = impulse - peakAt;
  if (peak < 0.1 || firstSample > 0 || firstSample < -0.15 * localAudioRate)
    throw Error("AACの音声時刻を確認できません。");
  return firstSample;
}
