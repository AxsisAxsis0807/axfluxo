import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ALL_VERSIONS_REFERENCE as REF } from "../../../../src/domain/video/all-versions-reference";
import { versionIntervals, type AllVersionsProject } from "../../../../src/domain/video/all-versions";
import type { RenderPlan, Segment } from "../../render/plan";
import { encoding } from "../../render/encode";
import { mediaProcess } from "../../render/process";
import { referenceTitleImage } from "./graphics";

/**
 * Reference layout is opt-in; legacy encoding remains in render.ts.
 * The timer is generated on the server at 60fps, with no per-frame PNG files.
 * Keep alpha curves aligned with referenceOpacity in all-versions-reference.ts.
 */
type Graphics = { bg: string; texts: Map<number, string> };
const clamp = (expr: string) => "max(0,min(1," + expr + "))";
function alphaExpression(
  track: "title" | "timer",
  timestamp: "T" | "t",
  duration: number,
  fadeIn: number,
  fadeOut: number,
  isFirst: boolean,
) {
  const start = fadeIn ? clamp(timestamp + "/" + fadeIn) : "1";
  const end = fadeOut ? clamp("(" + timestamp + "-" + (duration - fadeOut) + ")/" + fadeOut) : "0";
  const enter = track === "title"
    ? (isFirst ? "" : "(0.05+0.95*") +
      "(1-pow(1-" + start + "," + (isFirst ? "3.4" : "3.8") + "))" +
      (isFirst ? "" : ")")
    : "0.5-0.5*cos(PI*pow(" + start + ",0.83))";
  const exit = track === "title"
    ? "1-pow(" + end + ",2.6)"
    : "0.5+0.5*cos(PI*pow(" + end + ",0.86))";
  return "(" + enter + ")*(" + exit + ")*" +
    (track === "title" ? REF.titleOpacityScale : REF.timerOpacityScale);
}
function clockExpansion(localSegmentStartFrame: number) {
  // Segment starts are arbitrary; FFmpeg's n starts at zero per segment.
  const total = "1+floor(max(0,n+" + localSegmentStartFrame + "-6)/60)";
  return "%{eif\\:floor((" + total + ")/60)\\:d\\:2}\\:%{eif\\:mod((" + total + "),60)\\:d\\:2}";
}
export async function encodeReferenceProjectSegment(
  project: AllVersionsProject,
  segment: Segment,
  plan: RenderPlan,
  graphics: Graphics,
  dir: string,
  outputPath: string,
  signal?: AbortSignal,
) {
  const versions = versionIntervals(project);
  const index = versions.findIndex(
    (v) => segment.outputStartFrame >= v.startFrame && segment.outputStartFrame < v.endFrame,
  );
  const version = versions[index];
  if (!version) throw new Error("Reference segment does not match a version");
  let titleFile = graphics.texts.get(index);
  if (!titleFile) {
    titleFile = join(dir, "reference-title-" + index + ".png");
    await writeFile(titleFile, (await referenceTitleImage(project, index)).png);
    graphics.texts.set(index, titleFile);
  }
  const offsetFrames = segment.outputStartFrame - version.startFrame;
  const offset = offsetFrames / 60;
  const duration = (version.endFrame - version.startFrame) / 60;
  const fadeIn = project.design.fadeInFrames / 60;
  const fadeOut = project.design.fadeOutFrames / 60;
  const first = version.startFrame === 0;
  const titleAlpha = alphaExpression("title", "T", duration, fadeIn, fadeOut, first);
  const timerAlpha = alphaExpression("timer", "t", duration, fadeIn, fadeOut, first);
  const fontFile = resolve(
    process.env.VIDEO_FNF_FONT ??
    "server/worker/templates/fnf-showcase/assets/NotoSansJP.ttf",
  );
  const titleTop = Math.round(plan.height * REF.titleBandTop / REF.height);
  const timerSize = Math.round(plan.height * REF.timerFontSize / REF.height);
  const clock = clockExpansion(offsetFrames);
  const graph = [
    "[1:v]format=rgba,setpts=PTS+" + offset + "/TB,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*" + titleAlpha + "'[title]",
    "[0:v]setpts=PTS+" + offset + "/TB[bg]",
    "[bg][title]overlay=x=(W-w)/2:y=" + titleTop + ":shortest=1:format=auto",
    "drawtext=fontfile=" + fontFile + ":text='" + clock + "':fontsize=" + timerSize +
      ":fontcolor=white:x=(w-text_w)/2:y=" + (plan.height * REF.timerCenterY / REF.height) +
      "-text_h/2:alpha='" + timerAlpha + "'",
    "setpts=PTS-" + offset + "/TB,format=yuv420p,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[v]",
  ];
  await mediaProcess(
    "ffmpeg",
    [
      "-nostdin", "-xerror", "-filter_complex_threads", "1",
      "-loop", "1", "-framerate", "60", "-i", graphics.bg,
      "-loop", "1", "-framerate", "60", "-i", titleFile,
      "-filter_complex",
      graph[0] + ";" + graph[1] + ";" + graph.slice(2).join(","),
      "-map", "[v]", "-an", "-frames:v", String(segment.frames),
      ...encoding, "-bf", "0", "-map_metadata", "-1", "-y", outputPath,
    ],
    { signal },
  );
}
