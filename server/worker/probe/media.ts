import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { LIMITS } from "../../../src/config/limits";
import { ApiError } from "../../api/errors";
export type MediaProbe = {
  mime: string;
  kind: "image" | "audio" | "video";
  width?: number;
  height?: number;
  durationUs?: number;
  codecs: string[];
};
export async function probeMedia(
  path: string,
  size: number,
  declared: string,
  signal?: AbortSignal,
): Promise<MediaProbe> {
  const file = await open(path, "r");
  const header = Buffer.alloc(32);
  try {
    await file.read(header, 0, 32, 0);
  } finally {
    await file.close();
  }
  let mime: string | undefined;
  if (
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    mime = "image/png";
  else if (header[0] === 255 && header[1] === 216 && header[2] === 255)
    mime = "image/jpeg";
  else if (
    header.toString("ascii", 0, 4) === "RIFF" &&
    header.toString("ascii", 8, 12) === "WEBP"
  )
    mime = "image/webp";
  else if (
    header.toString("ascii", 0, 4) === "RIFF" &&
    header.toString("ascii", 8, 12) === "WAVE"
  )
    mime = "audio/wav";
  else if (header.toString("ascii", 4, 8) === "ftyp")
    mime =
      header.toString("ascii", 8, 12) === "qt  "
        ? "video/quicktime"
        : "video/mp4";
  else if (header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    mime = "video/webm";
  else if (header.toString("ascii", 0, 4) === "OggS") mime = "audio/ogg";
  if (!mime) throw new ApiError(422, "CORRUPT_MEDIA");
  if (mime !== declared) throw new ApiError(422, "MIME_MISMATCH");
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
        signal,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C",
          NODE_ENV: "production",
        },
      },
    );
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ApiError(422, "CORRUPT_MEDIA"));
    }, 30000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 256 * 1024) {
        child.kill("SIGKILL");
        reject(new ApiError(422, "CORRUPT_MEDIA"));
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new ApiError(503, "STORAGE_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new ApiError(422, "CORRUPT_MEDIA"));
    });
  });
  let data: {
    streams?: {
      codec_name?: string;
      codec_type?: string;
      width?: number;
      height?: number;
      duration?: string;
    }[];
    format?: { duration?: string; format_name?: string };
  };
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(422, "CORRUPT_MEDIA");
  }
  const streams = data.streams ?? [],
    video = streams.find((s) => s.codec_type === "video"),
    audio = streams.find((s) => s.codec_type === "audio"),
    kind = mime.startsWith("image/")
      ? "image"
      : mime.startsWith("audio/")
        ? "audio"
        : "video";
  if (
    !streams.length ||
    (kind !== "audio" && !video) ||
    (kind === "audio" && !audio)
  )
    throw new ApiError(422, "CORRUPT_MEDIA");
  const supported = new Set([
    "h264",
    "hevc",
    "vp8",
    "vp9",
    "av1",
    "aac",
    "opus",
    "vorbis",
    "pcm_s16le",
    "pcm_s24le",
    "pcm_s32le",
    "pcm_f32le",
    "png",
    "mjpeg",
    "webp",
  ]);
  if (streams.some((s) => !supported.has(s.codec_name ?? "")))
    throw new ApiError(422, "CODEC_UNSUPPORTED");
  if (
    kind === "image" &&
    (size > LIMITS.imageBytes ||
      !video?.width ||
      !video.height ||
      video.width > LIMITS.imageSide ||
      video.height > LIMITS.imageSide ||
      video.width * video.height > LIMITS.imagePixels)
  )
    throw new ApiError(422, "CORRUPT_MEDIA");
  const duration = Number(
    data.format?.duration ?? video?.duration ?? audio?.duration,
  );
  if (
    kind !== "image" &&
    (!Number.isFinite(duration) ||
      duration <= 0 ||
      duration * 1_000_000 > Number.MAX_SAFE_INTEGER)
  )
    throw new ApiError(422, "CORRUPT_MEDIA");
  return {
    mime,
    kind,
    codecs: streams.map((s) => s.codec_name!),
    ...(video ? { width: video.width, height: video.height } : {}),
    ...(kind !== "image"
      ? { durationUs: Math.round(duration * 1_000_000) }
      : {}),
  };
}
