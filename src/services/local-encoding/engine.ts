import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { asset, read, MAX_BYTES, type LocalJob } from "./storage";
import { plan } from "./plan";
import { localBackground, localText, localOverlay } from "./graphics";
export interface EncodingEngine {
  chunk(job: LocalJob, signal: AbortSignal): Promise<Blob>;
  finish(job: LocalJob, signal: AbortSignal): Promise<Blob>;
  dispose(): void;
}
const sec = (us: number) => (us / 1e6).toFixed(6);
/** Single-thread WASM only: no SharedArrayBuffer, external encoder, or media upload. */
export class WasmEngine implements EncodingEngine {
  private instance: FFmpeg | null = null;
  private get ff() {
    if (!this.instance) throw Error("Encoder is not loaded");
    return this.instance;
  }
  private async load(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.instance?.loaded) {
      const root = `${location.origin}${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/local-encoding`;
      const { FFmpeg } = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ `${root}/ffmpeg.js`
      )) as typeof import("@ffmpeg/ffmpeg");
      signal.throwIfAborted();
      this.instance = new FFmpeg();

      await this.ff.load(
        {
          classWorkerURL: `${root}/worker.js`,
          coreURL: `${root}/ffmpeg-core.js`,
          wasmURL: `${root}/ffmpeg-core.wasm`,
        },
        { signal },
      );
    }
  }
  private async put(name: string, blob: Blob, signal: AbortSignal) {
    if (blob.size > MAX_BYTES)
      throw Error(
        "端末のメモリー保護上限（192MiB）を超えます。短い範囲に分けてください。",
      );
    signal.throwIfAborted();
    await this.ff.writeFile(name, new Uint8Array(await blob.arrayBuffer()), {
      signal,
    });
  }
  private async exec(args: string[], signal: AbortSignal) {
    const code = await this.ff.exec(
      [
        "-nostdin",
        "-filter_threads",
        "1",
        "-filter_complex_threads",
        "1",
        ...args,
        "-y",
      ],
      -1,
      { signal },
    );
    if (code !== 0)
      throw Error(
        "端末内エンコードに失敗しました。素材の形式・空き容量を確認してください。",
      );
  }
  async chunk(job: LocalJob, signal: AbortSignal) {
    await this.load(signal);
    const p = plan(job.snapshot, job.outputIndex)[job.next],
      s = job.snapshot,
      c = s.document!.clips[p.clipIndex];
    const input = await asset(job.owner, c.source.versionId);
    if (!input || input.reference.hash !== c.source.hash)
      throw Error("元素材が端末にありません。");
    await this.put("source", input.blob, signal);
    // The distributed single-thread core exposes only a minimal ffprobe shim.
    // Inspect FFmpeg's demuxer output without decoding or re-encoding any frames.
    const messages: string[] = [];
    const inspect = ({ message }: { message: string }) =>
      messages.push(message);
    this.ff.on("log", inspect);
    try {
      await this.ff.exec(["-i", "source"], -1, { signal });
    } finally {
      this.ff.off("log", inspect);
    }
    const streams = messages
      .filter((line) => /Stream #0:/.test(line))
      .join("\n");
    if (!/(Audio|Video):/.test(streams))
      throw Error("素材の形式を確認できません。");
    if (/bt2020|smpte2084|arib-std-b67/.test(streams))
      throw Error(
        "HDR素材の端末内変換は未対応です。SDR原本を使用してください。",
      );
    const hasAudio = /Audio:/.test(streams);
    const mono = /Audio:.*\bmono\b/.test(streams);
    const duration = p.frames / 60,
      inputs = ["-ss", sec(p.sourceStartUs), "-i", "source"];
    const audioIndex = 3;
    let filter: string;
    if (s.kind === "all-versions-project") {
      const cover = await asset(job.owner, s.cover!.versionId);
      if (!cover) throw Error("coverが端末にありません。");
      await this.put(
        "background.png",
        await localBackground(s, cover.blob),
        signal,
      );
      await this.put("text.png", await localText(s, p.version), signal);
      inputs.push(
        "-loop",
        "1",
        "-framerate",
        "60",
        "-i",
        "background.png",
        "-loop",
        "1",
        "-framerate",
        "60",
        "-i",
        "text.png",
      );
      // Fade uses version-relative frame offsets, including across chunk boundaries.
      const d = s.design;
      const fades = [
        d.fadeInFrames ? `fade=t=in:st=0:d=${d.fadeInFrames / 60}:alpha=1` : "",
        d.fadeOutFrames
          ? `fade=t=out:st=${(p.versionFrames - d.fadeOutFrames) / 60}:d=${d.fadeOutFrames / 60}:alpha=1`
          : "",
      ].filter(Boolean);
      filter = `[2:v]format=rgba,setpts=PTS+${p.versionFrame}/60/TB${fades.length ? "," + fades.join(",") : ""},setpts=PTS-STARTPTS[text];[1:v][text]overlay=0:0:shortest=1,scale=in_range=auto:out_range=tv:out_color_matrix=bt709,format=yuv420p,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[v]`;
    } else {
      const t = s.preferences.template,
        h = input.height - t.cropTop - t.cropBottom;
      const w = Math.floor((input.width * t.scale) / 2) * 2,
        height = Math.floor((h * t.scale) / 2) * 2;
      if (h <= 0 || w < 2 || height < 2 || w * height > 32_000_000)
        throw Error("FNF_INVALID_CROP");
      await this.put("text.png", await localOverlay(s.preferences), signal);
      inputs.push(
        "-f",
        "lavfi",
        "-i",
        `color=black:s=1080x1920:r=60:d=${duration}`,
        "-loop",
        "1",
        "-framerate",
        "60",
        "-i",
        "text.png",
      );
      filter = `[0:v]setpts=PTS-STARTPTS,fps=60,crop=iw:ih-${t.cropTop}-${t.cropBottom}:0:${t.cropTop},scale=${w}:${height},setsar=1[game];[1:v][game]overlay=(W-w)/2:(H-h)/2:shortest=1[base];[base][2:v]overlay=0:0:shortest=1,scale=in_range=auto:out_range=tv:out_color_matrix=bt709,format=yuv420p,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[v]`;
    }
    if (!hasAudio)
      inputs.push("-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo`);
    filter += `;[${hasAudio ? 0 : audioIndex}:a:0]asetpts=PTS-STARTPTS${mono ? ",pan=stereo|c0=c0|c1=c0" : ""},aresample=48000,aformat=channel_layouts=stereo,apad,atrim=end_sample=${p.frames * 800}[a]`;
    try {
      await this.exec(
        [
          ...inputs,
          "-filter_complex",
          filter,
          "-map",
          "[v]",
          "-map",
          "[a]",
          "-frames:v",
          String(p.frames),
          "-t",
          String(duration),
          "-c:v",
          "libx264",
          "-crf",
          "18",
          "-preset",
          "medium",
          "-threads",
          "1",
          "-r",
          "60",
          "-pix_fmt",
          "yuv420p",
          "-color_primaries",
          "bt709",
          "-color_trc",
          "bt709",
          "-colorspace",
          "bt709",
          "-c:a",
          "pcm_s16le",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-map_metadata",
          "-1",
          "part.mkv",
        ],
        signal,
      );
      return new Blob(
        [new Uint8Array((await this.ff.readFile("part.mkv")) as Uint8Array)],
        { type: "video/x-matroska" },
      );
    } finally {
      for (const name of [
        "source",
        "probe.json",
        "background.png",
        "text.png",
        "part.mkv",
      ])
        await this.ff.deleteFile(name).catch(() => {});
    }
  }
  async finish(job: LocalJob, signal: AbortSignal) {
    await this.load(signal);
    let bytes = 0;
    try {
      for (let i = 0; i < job.total; i++) {
        const blob = await read<Blob>(job.owner, `part:${job.id}:${i}`);
        if (!blob) throw Error("保存済みチャンクがありません。");
        bytes += blob.size;
        if (bytes > MAX_BYTES)
          throw Error(
            "結合用メモリー上限（192MiB）です。短い動画に分けてください。保存済みデータは保持しています。",
          );
        await this.put(`p${i}.mkv`, blob, signal);
      }
      await this.ff.writeFile(
        "list.txt",
        new TextEncoder().encode(
          Array.from({ length: job.total }, (_, i) => `file 'p${i}.mkv'`).join(
            "\n",
          ),
        ),
        { signal },
      );
      // PCM checkpoints avoid repeated lossy audio encodes and AAC priming gaps.
      await this.exec(
        [
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          "list.txt",
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
          "-threads",
          "1",
          "-movflags",
          "+faststart",
          "-video_track_timescale",
          "60000",
          "out.mp4",
        ],
        signal,
      );
      return new Blob(
        [new Uint8Array((await this.ff.readFile("out.mp4")) as Uint8Array)],
        { type: "video/mp4" },
      );
    } finally {
      for (const name of [
        "list.txt",
        "out.mp4",
        ...Array.from({ length: job.total }, (_, i) => `p${i}.mkv`),
      ])
        await this.ff.deleteFile(name).catch(() => {});
    }
  }
  async waveform(owner: string, versionId: string, signal: AbortSignal) {
    const input = await asset(owner, versionId);
    if (!input) throw Error("SOURCE_MISSING");
    await this.load(signal);
    await this.put("source", input.blob, signal);
    const peaks: number[] = [];
    let activeMs = 0;
    try {
      for (let startUs = 0; startUs < input.durationUs; startUs += 30_000_000) {
        signal.throwIfAborted();
        const started = performance.now();
        await this.exec(
          [
            "-ss",
            sec(startUs),
            "-i",
            "source",
            "-t",
            String(Math.min(30, (input.durationUs - startUs) / 1e6)),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "f32le",
            "wave.bin",
          ],
          signal,
        );
        const bytes = new Uint8Array(
            (await this.ff.readFile("wave.bin")) as Uint8Array,
          ),
          data = new DataView(bytes.buffer);
        for (let i = 0; i < bytes.length; i += 640) {
          let peak = 0;
          for (let j = i; j < Math.min(i + 640, bytes.length); j += 4)
            peak = Math.max(peak, Math.abs(data.getFloat32(j, true)));
          peaks.push(Math.min(1, peak));
        }
        await this.ff.deleteFile("wave.bin");
        activeMs += performance.now() - started;
        if (activeMs >= 600_000) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 240_000);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(signal.reason);
              },
              { once: true },
            );
          });
          activeMs = 0;
        }
      }
      return {
        schemaVersion: 1 as const,
        versionId,
        hash: input.reference.hash,
        originUs: 0,
        sampleRate: 8000 as const,
        levels: [{ stepUs: 20000, peaks }],
      };
    } finally {
      await this.ff.deleteFile("source").catch(() => {});
    }
  }
  dispose() {
    this.instance?.terminate();
    this.instance = null;
  }
}
