import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  versionIntervals,
  projectIssues,
  type AllVersionsProject,
} from "../../../../src/domain/video/all-versions";
import { renderPlan, type RenderPlan, type Segment } from "../../render/plan";
import type { FnfSnapshot } from "../../../../src/domain/video/schema";
import { digest } from "../../../api/jobs";
import { RenderError } from "../../jobs/errors";
import { textImage, backgroundImage, dimensions } from "./graphics";
import { mediaProcess } from "../../render/process";
import { encoding } from "../../render/encode";
import { encodeReferenceProjectSegment } from "./reference-render";
export function projectPlan(
  project: AllVersionsProject,
  snapshot: FnfSnapshot,
  segmentFrames = 1800,
): RenderPlan {
  if (projectIssues(project).length) throw new RenderError("INPUT_UNSUPPORTED");
  const plan = renderPlan(snapshot, 0, "all-versions", segmentFrames, true),
    segments: Segment[] = [];
  for (const v of versionIntervals(project)) {
    const piece = plan.pieces.find((p) => p.clipIndex === v.clipIndex)!;
    for (let start = v.startFrame; start < v.endFrame; start += segmentFrames)
      segments.push({
        ...piece,
        index: segments.length,
        outputStartFrame: start,
        frames: Math.min(segmentFrames, v.endFrame - start),
        sourceStartUs:
          piece.sourceStartUs +
          Math.round(((start - piece.outputStartFrame) * 1e6) / 60),
      });
  }
  return {
    ...plan,
    ...dimensions(project),
    segments,
    hash: digest({ plan: plan.hash, project }),
  };
}
export async function prepareGraphics(
  project: AllVersionsProject,
  cover: string,
  dir: string,
) {
  const bg = join(dir, "background.png");
  await writeFile(bg, await backgroundImage(project, cover));
  return { bg, texts: new Map<number, string>() };
}
export async function encodeProjectSegment(
  project: AllVersionsProject,
  s: Segment,
  plan: RenderPlan,
  graphics: Awaited<ReturnType<typeof prepareGraphics>>,
  dir: string,
  path: string,
  signal?: AbortSignal,
) {
  if (project.design.layout === "reference-pasa-v1")
    return encodeReferenceProjectSegment(project, s, plan, graphics, dir, path, signal);
  const intervals = versionIntervals(project),
    index = intervals.findIndex(
      (v) =>
        s.outputStartFrame >= v.startFrame && s.outputStartFrame < v.endFrame,
    ),
    v = intervals[index];
  let text = graphics.texts.get(index);
  if (!text) {
    text = join(dir, `text-${index}.png`);
    await writeFile(text, (await textImage(project, index)).png);
    graphics.texts.set(index, text);
  }
  const offset = (s.outputStartFrame - v.startFrame) / 60,
    filters = ["format=rgba", `setpts=PTS+${offset}/TB`];
  if (project.design.fadeInFrames)
    filters.push(
      `fade=t=in:st=0:d=${project.design.fadeInFrames / 60}:alpha=1`,
    );
  if (project.design.fadeOutFrames)
    filters.push(
      `fade=t=out:st=${(v.endFrame - v.startFrame - project.design.fadeOutFrames) / 60}:d=${project.design.fadeOutFrames / 60}:alpha=1`,
    );
  filters.push(`setpts=PTS-${offset}/TB`);
  await mediaProcess(
    "ffmpeg",
    [
      "-nostdin",
      "-xerror",
      "-filter_complex_threads",
      "1",
      "-loop",
      "1",
      "-framerate",
      "60",
      "-i",
      graphics.bg,
      "-loop",
      "1",
      "-framerate",
      "60",
      "-i",
      text,
      "-filter_complex",
      `[1:v]${filters.join(",")}[text];[0:v][text]overlay=shortest=1:format=auto,format=yuv420p,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[v]`,
      "-map",
      "[v]",
      "-an",
      "-frames:v",
      String(s.frames),
      ...encoding,
      "-bf",
      "0",
      "-map_metadata",
      "-1",
      "-y",
      path,
    ],
    { signal },
  );
}
