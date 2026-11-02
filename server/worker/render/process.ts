import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { RenderError } from "../jobs/errors";
export function localPath(path: string) {
  if (
    !isAbsolute(path) ||
    path.includes("\n") ||
    path.includes("\r") ||
    path.includes("'")
  )
    throw new RenderError("INPUT_UNSUPPORTED");
  return path;
}
/** No shell, URLs, inherited credentials, or unbounded captured media/stdout. */
export async function mediaProcess(
  program: "ffmpeg" | "ffprobe",
  args: string[],
  options: {
    signal?: AbortSignal;
    line?: (line: string) => void;
    chunk?: (data: Buffer) => void;
    timeoutMs?: number;
  } = {},
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      program,
      ["-v", "error", "-protocol_whitelist", "file,pipe", ...args],
      {
        stdio: ["ignore", "pipe", "pipe"],
        signal: options.signal,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C",
          NODE_ENV: "production",
        },
        shell: false,
      },
    );
    let text = "",
      line = "",
      stderr = "",
      timed = false;
    const timer = setTimeout(() => {
      timed = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 86_400_000);
    child.stdout.on("data", (b: Buffer) => {
      if (options.chunk) {
        options.chunk(b);
        return;
      }
      if (options.line) {
        line += b.toString();
        const lines = line.split("\n");
        line = lines.pop()!;
        try {
          for (const l of lines) options.line(l);
        } catch (e) {
          child.kill("SIGKILL");
          reject(e);
        }
        if (line.length > 65536) {
          child.kill("SIGKILL");
          reject(new RenderError("VALIDATION_FAILED"));
        }
      } else {
        text += b.toString();
        if (text.length > 1024 * 1024) {
          child.kill("SIGKILL");
          reject(new RenderError("VALIDATION_FAILED"));
        }
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-16384);
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        new RenderError(
          options.signal?.aborted ? "LEASE_LOST" : "INPUT_UNSUPPORTED",
        ),
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (options.signal?.aborted) return reject(new RenderError("LEASE_LOST"));
      if (timed) return reject(new RenderError("PROCESS_TIMEOUT"));
      if (code !== 0)
        return reject(
          new RenderError(
            /No space left|Disk quota/i.test(stderr)
              ? "DISK_FULL"
              : signal === "SIGKILL" ||
                  /Cannot allocate memory|out of memory/i.test(stderr)
                ? "OUT_OF_MEMORY"
                : "INPUT_CORRUPT",
          ),
        );
      if (options.line && line) {
        try {
          options.line(line);
        } catch (e) {
          reject(e);
          return;
        }
      }
      resolve(text);
    });
  });
}
export type Track = {
  codec_type: string;
  codec_name: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  time_base: string;
  start_time?: string;
  duration?: string;
  nb_frames?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  color_transfer?: string;
  color_primaries?: string;
  color_space?: string;
  side_data_list?: { rotation?: number }[];
};
export async function probe(path: string, signal?: AbortSignal) {
  const json = await mediaProcess(
    "ffprobe",
    ["-show_streams", "-show_format", "-of", "json", localPath(path)],
    { signal, timeoutMs: 30000 },
  );
  return JSON.parse(json) as {
    streams: Track[];
    format: { duration: string; start_time?: string };
  };
}
export async function fileHash(path: string) {
  const { createReadStream } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
  for await (const b of createReadStream(localPath(path))) h.update(b);
  return h.digest("hex");
}
