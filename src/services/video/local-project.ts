import { imageForEncode, type LocalEncodeJob } from "./local-encode";
import { fnfFilenames, FNF_HEADING } from "../../domain/video/fnf-showcase";
export type TimelineState = {
  boundarySettings?: import("./track-boundaries").BoundarySettings;
  boundaryPlacement?: import("./track-boundaries").BoundaryPlacement;
  detection?: import("./track-boundaries").BoundaryAnalysis;
  selectedBoundary?: string;
  snapEnabled?: boolean;
  currentUs: number;
  zoom: number;
  gain: number;
  editing: boolean;
  selected: string;
};
export type Source = {
  timeline?: TimelineState;
  id: string;
  file: File;
  assetId?: string;
  audio?: {
    name: string;
    status: "ready";
    sampleRate: number | null;
    channels: number | null;
  };
  url: string;
  duration: number;
  width: number;
  height: number;
  start: number;
  end: number;
  markers: string;
};
export type Range = { id: string; start: number; end: number; name: string };
export function localIntervals(
  sources: Pick<Source, "start" | "end" | "duration" | "markers">[],
) {
  let offset = 0;
  return sources.flatMap((s) => {
    if (
      ![s.start, s.end, s.duration].every(Number.isFinite) ||
      s.start < 0 ||
      s.end <= s.start ||
      s.end > s.duration
    )
      throw Error("開始・終了時刻を素材の長さの範囲内で指定してください。");
    const markers = s.markers.trim()
      ? s.markers.split(",").map((v) => Number(v.trim()))
      : [];
    if (
      markers.some(
        (m, i) =>
          !Number.isFinite(m) ||
          m <= s.start ||
          m >= s.end ||
          (i > 0 && m <= markers[i - 1]),
      )
    )
      throw Error(
        "version境界は区間内の秒数を昇順・カンマ区切りで指定してください。",
      );
    const bounds = [s.start, ...markers, s.end];
    const result = bounds.slice(0, -1).map((value, i) => ({
      start: offset + value - s.start,
      end: offset + bounds[i + 1] - s.start,
    }));
    offset += s.end - s.start;
    return result;
  });
}
export const versionNameSuggestions = [
  "Original",
  "Slowed",
  "Super Slowed",
  "Sped Up",
] as const;
function versionLabels(sources: Source[], names: string) {
  const count = localIntervals(
    sources.filter((source) => !source.audio),
  ).length;
  const legacy = count ? names.replace(/\r\n?/g, "\n").split("\n") : [];
  if (legacy.length !== count || legacy.some((label) => !label.trim()))
    throw Error(
      `Version名は${count}行必要です。1つの素材に複数の名前を付ける場合は、Version境界を設定してください。`,
    );
  let offset = 0;
  return sources.flatMap((source) => {
    if (source.audio) return [source.audio.name];
    const start = offset;
    offset += localIntervals([source]).length;
    return legacy.slice(start, offset);
  });
}

export type LocalProjectData = {
  rest?: boolean;
  id: string;
  mode: "all-versions" | "fnf-showcase";
  sources: Source[];
  cover: string;
  coverFile?: File;
  coverId: string;
  names: string;
  ranges: Range[];
  username: string;
  scaleFactor: number;
  cropTop: number;
  cropBottom: number;
};
function line(
  ctx: CanvasRenderingContext2D,
  text: string,
  y: number,
  max: number,
  size = 56,
) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  do {
    ctx.font = `700 ${size--}px sans-serif`;
  } while (ctx.measureText(text).width > max && size > 10);
  ctx.lineWidth = 6;
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  ctx.strokeText(text, ctx.canvas.width / 2, y, max);
  ctx.fillText(text, ctx.canvas.width / 2, y, max);
}
/** Pre-render immutable text at its original canvas scale and integer baseline.
 * Small strips avoid allocating a full 1080x1920 overlay for each FNF range. */
function staticText(text: string, max: number, size: number) {
  try {
    const layer = document.createElement("canvas");
    layer.width = 1080;
    layer.height = size * 2 + 16;
    const context = layer.getContext("2d");
    if (!context) return null;
    line(context, text, layer.height / 2, max, size);
    return layer;
  } catch {
    // A constrained device can still use the original per-frame text path.
    return null;
  }
}

function drawStaticText(
  context: CanvasRenderingContext2D,
  layer: HTMLCanvasElement | null,
  text: string,
  y: number,
  max: number,
  size: number,
) {
  if (layer) context.drawImage(layer, 0, y - layer.height / 2);
  else line(context, text, y, max, size);
}

/** The picture comes from the user's selected cover, never a replacement asset. */
function drawAllVersionsBackground(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
) {
  context.fillStyle = "black";
  context.fillRect(0, 0, 1920, 1080);
  context.save();
  context.globalAlpha = 0.65;
  context.filter = "blur(24px)";
  const scale = Math.max(2080 / image.width, 1200 / image.height);
  context.drawImage(
    image,
    (1920 - image.width * scale) / 2,
    (1080 - image.height * scale) / 2,
    image.width * scale,
    image.height * scale,
  );
  context.restore();
  const crop = Math.min(image.width, image.height);
  context.drawImage(
    image,
    (image.width - crop) / 2,
    (image.height - crop) / 2,
    crop,
    crop,
    660,
    130,
    600,
    600,
  );
}

function preRenderAllVersionsBackground(image: HTMLImageElement) {
  try {
    const layer = document.createElement("canvas");
    layer.width = 1920;
    layer.height = 1080;
    const context = layer.getContext("2d");
    if (!context) return null;
    drawAllVersionsBackground(context, image);
    return layer;
  } catch {
    // Preserve the legacy renderer if creating an extra canvas fails.
    return null;
  }
}

async function createLocalJobs(
  project: LocalProjectData,
): Promise<LocalEncodeJob[]> {
  const {
    sources,
    names,
    username,
    cropTop,
    cropBottom,
    scaleFactor,
    ranges,
    cover,
    mode,
  } = project;
  const fnf = mode === "fnf-showcase";
  if (!sources.length) throw Error("素材を選択してください。");
  if (fnf) {
    const source = sources[0];
    if (!/^@\S+$/.test(username))
      throw Error("@から始まるユーザー名を入力してください。");
    if (
      ![cropTop, cropBottom].every((v) => Number.isInteger(v) && v >= 0) ||
      (!source.audio && cropTop + cropBottom >= source.height)
    )
      throw Error("crop後に映像が残る値を指定してください。");
    if (
      !ranges.length ||
      ranges.some(
        (r) =>
          !r.name.trim() ||
          ![r.start, r.end].every(Number.isFinite) ||
          r.start < 0 ||
          r.end <= r.start ||
          r.end > source.duration,
      )
    )
      throw Error("各rangeの譜面名と開始・終了時刻を確認してください。");
    const ordered = [...ranges].sort((a, b) => a.start - b.start),
      filenames = fnfFilenames(ordered.map((r) => r.name));
    const cropped = source.height - cropTop - cropBottom,
      scale = source.audio
        ? 0
        : Math.min(1080 / source.width, 1400 / cropped) *
          Math.min(2, Math.max(0.1, scaleFactor)),
      w = source.width * scale,
      h = cropped * scale;
    // Build each text strip only on the first render of its range.
    // Avoid extra allocations for queued or restored jobs.
    let headingLayer: HTMLCanvasElement | null | undefined;
    let usernameLayer: HTMLCanvasElement | null | undefined;
    const titleLayers: (HTMLCanvasElement | null | undefined)[] = [];
    return ordered.map((range, i) => {
      function draw(ctx: CanvasRenderingContext2D, media?: HTMLVideoElement) {
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, 1080, 1920);
        if (media)
          ctx.drawImage(
            media,
            0,
            cropTop,
            source.width,
            cropped,
            (1080 - w) / 2,
            (1920 - h) / 2,
            w,
            h,
          );
        if (headingLayer === undefined)
          headingLayer = staticText(FNF_HEADING, 1000, 46);
        if (usernameLayer === undefined)
          usernameLayer = staticText(username, 1000, 64);
        if (titleLayers[i] === undefined)
          titleLayers[i] = staticText(range.name, 1000, 44);
        drawStaticText(ctx, headingLayer, FNF_HEADING, 130, 1000, 46);
        drawStaticText(ctx, titleLayers[i] ?? null, range.name, 240, 1000, 44);
        drawStaticText(ctx, usernameLayer, username, 1770, 1000, 64);
      }
      return {
        filename: filenames[i],
        width: 1080,
        height: 1920,
        pieces: [
          {
            kind: source.audio ? "audio" : "video",
            name: range.name,
            file: source.file,
            url: async () => source.url,
            start: range.start,
            end: range.end,
          },
        ],
        draw,
        drawAudio: (ctx) => draw(ctx),
      };
    });
  }
  const intervals = localIntervals(sources),
    labels = versionLabels(sources, names);
  if (labels.some((label) => !label.trim()))
    throw Error("各バージョン名を入力してください。");
  if (!cover) throw Error("カバー画像を選択してください。");
  // Keep the original image path as a fallback when a second canvas cannot be allocated.
  // The pre-rendered bitmap is created only when an export actually draws.
  let fallbackImage: HTMLImageElement | null = await imageForEncode(cover);
  let staticBackground: HTMLCanvasElement | null | undefined;
  function drawComposition(ctx: CanvasRenderingContext2D, seconds: number) {
    if (staticBackground === undefined) {
      staticBackground = preRenderAllVersionsBackground(fallbackImage!);
      if (staticBackground) fallbackImage = null;
    }
    if (staticBackground) ctx.drawImage(staticBackground, 0, 0);
    else drawAllVersionsBackground(ctx, fallbackImage!);
    const i = intervals.findIndex((v) => seconds >= v.start && seconds < v.end);
    if (i >= 0) {
      ctx.save();
      ctx.globalAlpha = Math.max(
        0,
        Math.min(
          1,
          (seconds - intervals[i].start) / 0.15,
          (intervals[i].end - seconds) / 0.15,
        ),
      );
      line(ctx, labels[i], 920, 1728, 80);
      ctx.restore();
    }
  }
  return [
    {
      filename: "All Versions.mp4",
      width: 1920,
      height: 1080,
      pieces: sources.map((s) => ({
        // Older All Versions projects may have audio in the original media slot.
        kind: s.audio || (s.width === 0 && s.height === 0) ? "audio" : "video",
        name: s.audio?.name,
        file: s.file,
        url: async () => s.url,
        start: s.start,
        end: s.end,
      })),
      draw: (ctx, _media, seconds) => drawComposition(ctx, seconds),
      drawAudio: drawComposition,
    },
  ];
}

export async function buildLocalJobs(
  value: LocalProjectData,
): Promise<LocalEncodeJob[]> {
  const issue = localProjectIssue(value);
  if (issue) throw Error(issue);
  const project = {
    ...value,
    sources: value.sources.map((s) => ({ ...s })),
    ranges: value.ranges.map((r) => ({ ...r })),
  };
  const jobs = await createLocalJobs(project);
  return jobs.map((job, index) => ({ ...job, recovery: { project, index } }));
}

/** Safe to call during rendering even while numeric inputs are incomplete. */
export function localProjectIssue(project: LocalProjectData): string {
  try {
    if (!project.sources.length) return "素材を選択してください。";
    if (project.mode === "all-versions") {
      localIntervals(project.sources);
      if (
        versionLabels(project.sources, project.names).some(
          (label) => !label.trim(),
        )
      )
        return "各バージョン名を入力してください。";
      if (!project.cover) return "カバー画像を選択してください。";
    } else {
      const source = project.sources[0];
      if (!/^@\S+$/.test(project.username))
        return "@から始まるユーザー名を入力してください。";
      if (
        !Number.isFinite(project.scaleFactor) ||
        project.scaleFactor < 0.1 ||
        project.scaleFactor > 2
      )
        return "映像スケールは0.1〜2で指定してください。";
      if (
        ![project.cropTop, project.cropBottom].every(
          (v) => Number.isInteger(v) && v >= 0,
        ) ||
        (!source.audio && project.cropTop + project.cropBottom >= source.height)
      )
        return "crop後に映像が残る値を指定してください。";
      if (
        !project.ranges.length ||
        project.ranges.some(
          (r) =>
            !r.name.trim() ||
            ![r.start, r.end].every(Number.isFinite) ||
            r.start < 0 ||
            r.end <= r.start ||
            r.end > source.duration,
        )
      )
        return "各rangeの譜面名と開始・終了時刻を確認してください。";
    }
    return "";
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "編集内容を確認してください。";
  }
}
