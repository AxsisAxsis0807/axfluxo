import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decimalUs } from "../derivatives/generate";
import { localPath, mediaProcess, probe, type Track } from "./process";
import type { Piece, RenderPlan, Segment } from "./plan";
import { RenderError } from "../jobs/errors";
export type Input = { path: string; info: Awaited<ReturnType<typeof probe>> };
const seconds = (us: number) => (us / 1e6).toFixed(6);
export const encoding = [
  "-c:v",
  "libx264",
  "-crf",
  "18",
  "-preset",
  "medium",
  "-pix_fmt",
  "yuv420p",
  "-threads:v",
  "2",
  "-r:v",
  "60",
  "-fps_mode:v",
  "cfr",
  "-video_track_timescale",
  "60000",
];
/** PQ/HLG linear-light tone mapping to BT.709 SDR; unsupported HDR metadata fails closed. */
export function colorFilter(v: Track) {
  const hdr = ["smpte2084", "arib-std-b67"].includes(v.color_transfer ?? "");
  if (hdr) {
    if (
      v.color_primaries !== "bt2020" ||
      !["bt2020nc", "bt2020c"].includes(v.color_space ?? "")
    )
      throw new RenderError("INPUT_UNSUPPORTED");
    return "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=limited,format=yuv420p";
  }
  if (v.color_primaries === "bt2020")
    throw new RenderError("INPUT_UNSUPPORTED");
  return "scale=in_range=auto:out_range=tv:out_color_matrix=bt709,format=yuv420p";
}
export async function encodeSegment(
  input: Input,
  s: Segment,
  plan: RenderPlan,
  path: string,
  signal?: AbortSignal,
) {
  const v = input.info.streams.find((t) => t.codec_type === "video");
  if (!v) throw new RenderError("INPUT_UNSUPPORTED");
  const origin = decimalUs(input.info.format.start_time ?? "0");
  const filter = [
    `setpts=PTS-(${seconds(origin)})/TB`,
    `trim=start=${seconds(Math.max(0, s.sourceStartUs - 1_000_000))}:end=${seconds(s.sourceEndUs)}`,
    `setpts=PTS-(${seconds(s.sourceStartUs)})/TB`,
    "fps=fps=60:start_time=0:round=near",
    `tpad=stop_mode=clone:stop_duration=${s.frames / 60}`,
    `trim=end_frame=${s.frames}`,
    colorFilter(v),
    // ffmpeg autorotate precedes these filters. SAR participates in fitting the displayed image.
    "scale=w=trunc(iw*sar/2)*2:h=ih",
    "setsar=1",
    `scale=w=${plan.width}:h=${plan.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:black`,
    "setsar=1",
    "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
  ].join(",");
  await mediaProcess(
    "ffmpeg",
    [
      "-nostdin",
      "-xerror",
      "-filter_threads",
      "1",
      "-copyts",
      ...(s.sourceStartUs > 2_000_000
        ? [
            "-seek_timestamp",
            "1",
            "-ss",
            seconds(origin + s.sourceStartUs - 2_000_000),
          ]
        : []),
      "-i",
      localPath(input.path),
      "-map",
      "0:v:0",
      "-an",
      "-vf",
      filter,
      ...encoding,
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      "-metadata:s:v:0",
      "rotate=0",
      "-map_metadata",
      "-1",
      "-y",
      localPath(path),
    ],
    { signal },
  );
}
export function canCopyAudio(plan: RenderPlan, inputs: Input[]) {
  if (plan.mode !== "fnf" || plan.pieces.length !== 1) return false;
  const p = plan.pieces[0],
    input = inputs[p.clipIndex],
    audio = input.info.streams.filter((t) => t.codec_type === "audio");
  if (audio.length !== 1) return false;
  const a = audio[0];
  return (
    p.sourceStartUs === 0 &&
    plan.snapshot.ranges[plan.index].startUs === 0 &&
    plan.snapshot.ranges[plan.index].endUs ===
      plan.snapshot.document.clips[p.clipIndex].sourceDurationUs &&
    p.sourceEndUs ===
      plan.snapshot.document.clips[p.clipIndex].sourceDurationUs &&
    decimalUs(input.info.format.start_time ?? "0") === 0 &&
    decimalUs(a.start_time ?? "-1") === 0 &&
    a.codec_name === "aac" &&
    a.profile === "LC" &&
    a.sample_rate === "48000" &&
    a.channels === 2 &&
    Math.abs(decimalUs(a.duration ?? "0") - (plan.frames * 1e6) / 60) <= 21 &&
    Math.abs(
      decimalUs(input.info.format.duration) - (plan.frames * 1e6) / 60,
    ) <= 21 &&
    plan.snapshot.document.clips[p.clipIndex].interval.startUs === 0 &&
    Math.abs(
      plan.snapshot.document.clips[p.clipIndex].sourceDurationUs -
        (plan.frames * 1e6) / 60,
    ) <= 21
  );
}
function audioFilter(p: Piece, input: Input, i: number, preserveMono = false) {
  const a = input.info.streams.find((t) => t.codec_type === "audio");
  const samples = p.frames * 800,
    label = `a${i}`;
  if (!a)
    return `anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples}[${label}]`;
  const origin = decimalUs(input.info.format.start_time ?? "0"),
    first = decimalUs(a.start_time ?? String(origin / 1e6)) - origin;
  const delay = Math.max(
    0,
    Math.round(((first - p.sourceStartUs) * 48000) / 1e6),
  );
  // Trim against common format origin; preserve audio/video lead, insert silence only where absent.
  return `[${i + 1}:a:0]asetpts=PTS-(${seconds(origin)})/TB,atrim=start=${seconds(p.sourceStartUs)}:end=${seconds(Math.min(p.sourceEndUs, p.sourceStartUs + (p.frames * 1e6) / 60))},asetpts=PTS-STARTPTS${preserveMono && a.channels === 1 ? ",pan=stereo|c0=c0|c1=c0" : ""},aformat=sample_rates=48000:channel_layouts=stereo${delay ? `,adelay=${delay}S:all=1` : ""},apad=whole_len=${samples},atrim=end_sample=${samples}[${label}]`;
}
export async function assemble(
  plan: RenderPlan,
  inputs: Input[],
  segments: string[],
  directory: string,
  signal?: AbortSignal,
  preciseMovieTime = false,
) {
  const list = join(directory, "segments.txt"),
    video = join(directory, "joined.mp4"),
    output = join(directory, "candidate.mp4");
  await writeFile(
    list,
    segments.map((p) => `file '${localPath(p)}'`).join("\n"),
  );
  await mediaProcess(
    "ffmpeg",
    [
      "-nostdin",
      "-xerror",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-map",
      "0:v:0",
      "-c:v",
      "copy",
      "-an",
      "-video_track_timescale",
      "60000",
      "-y",
      video,
    ],
    { signal },
  );
  if (canCopyAudio(plan, inputs)) {
    await mediaProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-xerror",
        "-i",
        video,
        "-i",
        inputs[plan.pieces[0].clipIndex].path,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c",
        "copy",
        "-video_track_timescale",
        "60000",
        "-map_metadata",
        "-1",
        "-movflags",
        "+faststart",
        "-y",
        output,
      ],
      { signal },
    );
    return { path: output, audioMode: "copy" as const };
  }
  const filters = plan.pieces.map((p, i) =>
    audioFilter(p, inputs[p.clipIndex], i, preciseMovieTime),
  );
  filters.push(
    `${plan.pieces.map((_, i) => `[a${i}]`).join("")}concat=n=${plan.pieces.length}:v=0:a=1[aout]`,
  );
  // Video segments have no AAC. This is the ONLY audio encode, across the whole output.
  await mediaProcess(
    "ffmpeg",
    [
      "-nostdin",
      "-xerror",
      "-filter_complex_threads",
      "1",
      "-i",
      video,
      ...plan.pieces.flatMap((p) => [
        "-copyts",
        "-i",
        localPath(inputs[p.clipIndex].path),
      ]),
      "-filter_complex",
      filters.join(";"),
      "-map",
      "0:v:0",
      "-map",
      "[aout]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-threads:a",
      "1",
      "-video_track_timescale",
      "60000",
      "-map_metadata",
      "-1",
      "-movflags",
      "+faststart",
      ...(preciseMovieTime ? ["-movie_timescale", "240000"] : []),
      "-y",
      output,
    ],
    { signal },
  );
  return { path: output, audioMode: "encoded" as const };
}
