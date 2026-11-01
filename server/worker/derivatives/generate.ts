import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function ffmpeg(args: string[], signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-v", "error", "-protocol_whitelist", "file,pipe", ...args],
      {
        stdio: "ignore",
        signal,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C",
          NODE_ENV: "production",
        },
      },
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("PREVIEW_FAILED"));
    });
  });
}
export type StreamMetadata = {
  codec_type: string;
  start_time?: string;
  time_base: string;
  avg_frame_rate?: string;
  width?: number;
  height?: number;
  side_data_list?: { rotation?: number }[];
};
export async function inspect(path: string) {
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        path,
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C",
          NODE_ENV: "production",
        },
      },
    );
    let result = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("PREVIEW_FAILED"));
    }, 30000);
    child.stdout.on("data", (b) => {
      result += b;
      if (result.length > 262144) child.kill();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(result);
      else reject(new Error("PREVIEW_FAILED"));
    });
  });
  return JSON.parse(text) as {
    streams: StreamMetadata[];
    format: { duration: string; start_time?: string };
  };
}
export function decimalUs(text: string) {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error("PREVIEW_FAILED");
  const n =
    BigInt(m[2]) * 1_000_000n + BigInt((m[3] ?? "").padEnd(6, "0").slice(0, 6));
  const value = Number(m[1] ? -n : n);
  if (!Number.isSafeInteger(value)) throw new Error("PREVIEW_FAILED");
  return value;
}
export async function generateMedia(
  source: string,
  dir: string,
  reference: { id: string; hash: string; durationUs: number },
  signal?: AbortSignal,
) {
  const original = await inspect(source),
    video = original.streams.find((s) => s.codec_type === "video");
  const audioOnly = !video;
  if (audioOnly && !original.streams.some((s) => s.codec_type === "audio"))
    throw new Error("PREVIEW_FAILED");
  const proxy = join(dir, "proxy.mp4"),
    thumbnail = join(dir, "thumbnail.jpg"),
    wave = join(dir, "waveform.json");
  await ffmpeg(
    [
      "-copyts",
      "-start_at_zero",
      "-i",
      source,
      ...(audioOnly
        ? [
            "-f",
            "lavfi",
            "-i",
            `color=c=black:s=160x90:r=1:d=${reference.durationUs / 1e6}`,
          ]
        : []),
      "-map",
      audioOnly ? "1:v:0" : "0:v:0",
      "-map",
      "0:a:0?",
      "-map_metadata",
      "-1",
      "-vf",
      "scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-bf",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-fps_mode:v",
      "passthrough",
      "-enc_time_base:v",
      "1:1000000",
      "-video_track_timescale",
      "1000000",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-metadata:s:v:0",
      "rotate=0",
      "-movflags",
      "+faststart",
      "-y",
      proxy,
    ],
    signal,
  );
  await ffmpeg(
    ["-i", proxy, "-frames:v", "1", "-vf", "scale=320:-2", "-y", thumbnail],
    signal,
  );
  const output = await inspect(proxy),
    v = output.streams.find((s) => s.codec_type === "video")!;
  const sourceFirstPtsUs = decimalUs(
      original.format.start_time ?? video?.start_time ?? "0",
    ),
    proxyFirstPtsUs = decimalUs(
      output.format.start_time ?? v.start_time ?? "0",
    );
  const audio = original.streams.find((s) => s.codec_type === "audio"),
    window = Math.max(
      800,
      Math.ceil(((reference.durationUs / 1_000_000) * 8000) / 100000) + 1,
    ),
    windows = [window, window * 10, window * 100],
    peaks: number[][] = [[], [], []],
    mins = [1, 1, 1],
    maxs = [-1, -1, -1];
  let sample = 0;
  if (audio)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "ffmpeg",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          source,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "8000",
          "-f",
          "s16le",
          "pipe:1",
        ],
        {
          stdio: ["ignore", "pipe", "ignore"],
          signal,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            LANG: "C",
            NODE_ENV: "production",
          },
        },
      );
      let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      child.stdout.on("data", (chunk: Buffer) => {
        const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        for (let i = 0; i + 1 < data.length; i += 2) {
          const value = data.readInt16LE(i) / 32768;
          for (let l = 0; l < 3; l++) {
            mins[l] = Math.min(mins[l], value);
            maxs[l] = Math.max(maxs[l], value);
            if ((sample + 1) % windows[l] === 0) {
              peaks[l].push(
                Number(mins[l].toFixed(4)),
                Number(maxs[l].toFixed(4)),
              );
              mins[l] = 1;
              maxs[l] = -1;
              if (peaks[l].length > 200000) {
                child.kill();
                reject(new Error("PREVIEW_FAILED"));
              }
            }
          }
          sample++;
        }
        carry =
          data.length % 2 ? data.subarray(data.length - 1) : Buffer.alloc(0);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("PREVIEW_FAILED"));
      });
    });
  for (let l = 0; l < 3; l++)
    if (sample % windows[l])
      peaks[l].push(Number(mins[l].toFixed(4)), Number(maxs[l].toFixed(4)));
  await writeFile(
    wave,
    JSON.stringify({
      schemaVersion: 1,
      versionId: reference.id,
      hash: reference.hash,
      originUs: audio
        ? decimalUs(audio.start_time ?? "0") - sourceFirstPtsUs
        : 0,
      sampleRate: 8000,
      levels: windows.map((n, l) => ({
        stepUs: (n / 8000) * 1_000_000,
        peaks: peaks[l],
      })),
    }),
  );
  const [num, den] = (video?.avg_frame_rate ?? "60/1").split("/").map(Number);
  return {
    files: [
      { kind: "proxy", path: proxy, mime: "video/mp4" },
      { kind: "thumbnail", path: thumbnail, mime: "image/jpeg" },
      { kind: "waveform", path: wave, mime: "application/json" },
    ],
    metadata: {
      durationUs: Math.min(
        reference.durationUs,
        decimalUs(output.format.duration) - proxyFirstPtsUs,
      ),
      width: v.width!,
      height: v.height!,
      rotationDegrees:
        video?.side_data_list?.find((s) => s.rotation !== undefined)
          ?.rotation ?? 0,
      mapping: {
        sourceFirstPtsUs,
        proxyFirstPtsUs,
        sourceTimeBase:
          video?.time_base ??
          original.streams.find((s) => s.codec_type === "audio")!.time_base,
        proxyTimeBase: v.time_base,
      },
      rate: { numerator: num || 60, denominator: den || 1 },
    },
  };
}
