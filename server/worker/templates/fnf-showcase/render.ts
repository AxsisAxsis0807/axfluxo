import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import {
  FNF_FONT_HASH,
  FNF_HEADING,
  FNF_RENDERER,
  type FnfPreferences,
} from "../../../../src/domain/video/fnf-showcase";
import { RenderError } from "../../jobs/errors";
import { sourceGeometry, rotationFilters } from "../../validation/geometry";
export { sourceGeometry } from "../../validation/geometry";
import { mediaProcess } from "../../render/process";
import { encoding, colorFilter, type Input } from "../../render/encode";
import { decimalUs } from "../../derivatives/generate";
import type { RenderPlan, Segment } from "../../render/plan";
let registered = false;
export async function fnfOverlay(p: FnfPreferences) {
  const font = await readFile(
    resolve(
      process.env.VIDEO_FNF_FONT ??
        (existsSync(
          resolve("server/worker/templates/fnf-showcase/assets/NotoSansJP.ttf"),
        )
          ? "server/worker/templates/fnf-showcase/assets/NotoSansJP.ttf"
          : "worker/templates/fnf-showcase/assets/NotoSansJP.ttf"),
    ),
  ).catch(() => {
    throw new RenderError("FNF_FONT_UNAVAILABLE");
  });
  if (createHash("sha256").update(font).digest("hex") !== FNF_FONT_HASH)
    throw new RenderError("FNF_FONT_UNAVAILABLE");
  if (!registered) {
    if (!GlobalFonts.register(font, "AxFluxoFnf"))
      throw new RenderError("FNF_FONT_UNAVAILABLE");
    registered = true;
  }
  const canvas = createCanvas(1080, 1920),
    ctx = canvas.getContext("2d");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  for (const line of [
    { text: FNF_HEADING, size: 37, y: 192 },
    { text: p.username, size: 64, y: 300 },
  ]) {
    ctx.font = `${line.size}px AxFluxoFnf`;
    const size = Math.min(
      line.size,
      (line.size * 1000) / Math.max(1, ctx.measureText(line.text).width),
    );
    ctx.font = `${size}px AxFluxoFnf`;
    ctx.lineWidth = Math.min(4, size * 0.06);
    ctx.strokeText(line.text, 540, line.y);
    ctx.fillText(line.text, 540, line.y);
  }
  return {
    png: await canvas.encode("png"),
    width: 1080,
    height: 1920,
    fontHash: FNF_FONT_HASH,
    rendererVersion: FNF_RENDERER,
  };
}
export function gameplayGeometry(
  p: FnfPreferences,
  source: { width: number; height: number },
) {
  if (
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width < 1 ||
    source.height < 1
  )
    throw new RenderError("FNF_INVALID_CROP");
  const h = source.height - p.template.cropTop - p.template.cropBottom,
    w = Math.floor((source.width * p.template.scale) / 2) * 2,
    height = Math.floor((h * p.template.scale) / 2) * 2;
  if (h <= 0 || w < 2 || height < 2) throw new RenderError("FNF_INVALID_CROP");
  if (w * height > 32_000_000) throw new RenderError("RESOURCE_LIMIT");
  return {
    width: w,
    height,
    x: (1080 - w) / 2,
    y: (1920 - height) / 2,
    presetMismatch:
      source.width !== p.template.presetWidth ||
      source.height !== p.template.presetHeight,
  };
}
export async function prepareFnf(p: FnfPreferences, dir: string) {
  const path = join(dir, "fnf-overlay.png");
  await writeFile(path, (await fnfOverlay(p)).png);
  return path;
}
export async function encodeFnfSegment(
  input: Input,
  s: Segment,
  plan: RenderPlan,
  p: FnfPreferences,
  overlay: string,
  path: string,
  signal?: AbortSignal,
) {
  const v = input.info.streams.find((t) => t.codec_type === "video");
  if (!v) throw new RenderError("INPUT_UNSUPPORTED");
  const geometry = gameplayGeometry(p, sourceGeometry(v)),
    origin = decimalUs(input.info.format.start_time ?? "0"),
    sec = (us: number) => (us / 1e6).toFixed(6);
  const filter = [
    `setpts=PTS-(${sec(origin)})/TB`,
    `trim=start=${sec(Math.max(0, s.sourceStartUs - 1_000_000))}:end=${sec(s.sourceEndUs)}`,
    `setpts=PTS-(${sec(s.sourceStartUs)})/TB`,
    "fps=fps=60:start_time=0:round=near",
    `tpad=stop_mode=clone:stop_duration=${s.frames / 60}`,
    `trim=end_frame=${s.frames}`,
    colorFilter(v),
    "scale=w=trunc(iw*sar/2)*2:h=ih",
    "setsar=1",
    ...rotationFilters(v),
    `crop=iw:ih-${p.template.cropTop}-${p.template.cropBottom}:0:${p.template.cropTop}:exact=1`,
    `scale=${geometry.width}:${geometry.height}`,
  ].join(",");
  await mediaProcess(
    "ffmpeg",
    [
      "-nostdin",
      "-xerror",
      "-filter_complex_threads",
      "1",
      "-copyts",
      ...(s.sourceStartUs > 2_000_000
        ? [
            "-seek_timestamp",
            "1",
            "-ss",
            sec(origin + s.sourceStartUs - 2_000_000),
          ]
        : []),
      "-noautorotate",
      "-i",
      input.path,
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=1080x1920:r=60:d=${s.frames / 60}`,
      "-loop",
      "1",
      "-framerate",
      "60",
      "-i",
      overlay,
      "-filter_complex",
      `[0:v]${filter}[game];[1:v][game]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1:format=auto[base];[base][2:v]overlay=0:0:shortest=1:format=auto,format=yuv420p,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[out]`,
      "-map",
      "[out]",
      "-an",
      "-frames:v",
      String(s.frames),
      ...encoding,
      "-bf",
      "0",
      "-metadata:s:v:0",
      "rotate=0",
      "-map_metadata",
      "-1",
      "-y",
      path,
    ],
    { signal },
  );
}
