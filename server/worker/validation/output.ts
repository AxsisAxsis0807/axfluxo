import { stat } from "node:fs/promises";
import { fileHash, mediaProcess, probe } from "../render/process";
import { RenderError } from "../jobs/errors";
import { decimalUs } from "../derivatives/generate";
export async function validateVideo(
  path: string,
  expected: { width: number; height: number; frames: number; audio?: boolean },
  signal?: AbortSignal,
) {
  const info = await probe(path, signal),
    video = info.streams.filter((t) => t.codec_type === "video"),
    audio = info.streams.filter((t) => t.codec_type === "audio");
  const v = video[0];
  if (
    video.length !== 1 ||
    !v ||
    v.codec_name !== "h264" ||
    v.pix_fmt !== "yuv420p" ||
    v.width !== expected.width ||
    v.height !== expected.height ||
    v.sample_aspect_ratio !== "1:1" ||
    v.avg_frame_rate !== "60/1" ||
    v.time_base !== "1/60000" ||
    v.color_transfer !== "bt709" ||
    (v.side_data_list ?? []).some((s) => s.rotation)
  )
    throw new RenderError("VALIDATION_FAILED");
  if (
    expected.audio &&
    (audio.length !== 1 ||
      audio[0].codec_name !== "aac" ||
      audio[0].sample_rate !== "48000" ||
      audio[0].channels !== 2)
  )
    throw new RenderError("VALIDATION_FAILED");
  if (!expected.audio && audio.length)
    throw new RenderError("VALIDATION_FAILED");
  let frames = 0;
  await mediaProcess(
    "ffprobe",
    [
      "-select_streams",
      "v:0",
      "-show_frames",
      "-show_entries",
      "frame=best_effort_timestamp",
      "-of",
      "compact=p=0:nk=0",
      path,
    ],
    {
      signal,
      line: (line) => {
        const match = /(?:^|\|)best_effort_timestamp=(-?\d+)(?:\||$)/.exec(
          line,
        );
        if (!match) return;
        if (BigInt(match[1]) !== BigInt(frames) * 1000n)
          throw new RenderError("VALIDATION_FAILED");
        frames++;
        if (frames > expected.frames)
          throw new RenderError("VALIDATION_FAILED");
      },
    },
  );
  if (
    frames !== expected.frames ||
    Math.abs(decimalUs(v.duration ?? "0") - (frames * 1e6) / 60) > 2
  )
    throw new RenderError("VALIDATION_FAILED");
  // Decoder errors, not just container headers, reject publication. No decoded bytes retained.
  await mediaProcess(
    "ffmpeg",
    [
      "-nostdin",
      "-xerror",
      "-err_detect",
      "explode",
      "-i",
      path,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-f",
      "null",
      "-",
    ],
    { signal },
  );
  let audioSamples = 0;
  if (expected.audio) {
    const a = audio[0];
    if (
      Math.abs(decimalUs(a.start_time ?? "-1")) > 21 ||
      Math.abs(decimalUs(a.duration ?? "0") - (frames * 1e6) / 60) > 22
    )
      throw new RenderError("VALIDATION_FAILED");
    let packets = 0,
      last: bigint | null = null,
      priming = 0;
    await mediaProcess(
      "ffprobe",
      [
        "-select_streams",
        "a:0",
        "-show_packets",
        "-show_entries",
        "packet=pts,duration:packet_side_data=skip_samples",
        "-of",
        "compact=p=0:nk=0",
        path,
      ],
      {
        signal,
        line: (line) => {
          const m = /(?:^|\|)pts=(-?\d+)/.exec(line);
          if (!m) return;
          const pts = BigInt(m[1]);
          if (last !== null && pts <= last)
            throw new RenderError("VALIDATION_FAILED");
          const skip = /(?:^|[|:])skip_samples=(\d+)/.exec(line);
          if (skip) priming += Number(skip[1]);
          if (pts < 0n && (packets !== 0 || !skip || BigInt(skip[1]) !== -pts))
            throw new RenderError("VALIDATION_FAILED");
          last = pts;
          packets++;
        },
      },
    );
    await mediaProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-xerror",
        "-i",
        path,
        "-map",
        "0:a:0",
        "-f",
        "s16le",
        "-c:a",
        "pcm_s16le",
        "pipe:1",
      ],
      {
        signal,
        chunk: (b) => {
          audioSamples += b.length / 4;
        },
      },
    );
    // AAC final packet padding may survive decoder output; no per-segment priming permitted.
    if (
      !packets ||
      priming > 1024 ||
      audioSamples < frames * 800 ||
      audioSamples - frames * 800 >= 1024
    )
      throw new RenderError("VALIDATION_FAILED");
  }
  return {
    schemaVersion: 1,
    width: expected.width,
    height: expected.height,
    codec: "h264",
    fps: 60,
    frames,
    durationUs: Math.round((frames * 1e6) / 60),
    audioSamples,
    sha256: await fileHash(path),
    size: (await stat(path)).size,
  };
}
