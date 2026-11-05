import { imageForEncode, type LocalEncodeJob } from "./local-encode";
import { fnfFilenames, FNF_HEADING } from "../../domain/video/fnf-showcase";
export type TimelineState = {
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
      cropTop + cropBottom >= source.height
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
      scale =
        Math.min(1080 / source.width, 1400 / cropped) *
        Math.min(2, Math.max(0.1, scaleFactor)),
      w = source.width * scale,
      h = cropped * scale;
    return ordered.map((range, i) => ({
      filename: filenames[i],
      width: 1080,
      height: 1920,
      pieces: [
        {
          file: source.file,
          url: async () => source.url,
          start: range.start,
          end: range.end,
        },
      ],
      draw: (ctx, media) => {
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, 1080, 1920);
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
        line(ctx, FNF_HEADING, 130, 1000, 46);
        line(ctx, range.name, 240, 1000, 44);
        line(ctx, username, 1770, 1000, 64);
      },
    }));
  }
  const intervals = localIntervals(sources),
    labels = names.replace(/\r\n?/g, "\n").split("\n");
  if (labels.length !== intervals.length || labels.some((v) => !v.trim()))
    throw Error(
      `名前をversion数（${intervals.length}）と同じ行数で入力してください。複数のVersion名にはVersion境界の設定が必要です。`,
    );
  if (!cover) throw Error("カバー画像を選択してください。");
  const image = await imageForEncode(cover);
  return [
    {
      filename: "All Versions.mp4",
      width: 1920,
      height: 1080,
      pieces: sources.map((s) => ({
        file: s.file,
        url: async () => s.url,
        start: s.start,
        end: s.end,
      })),
      draw: (ctx, _media, seconds) => {
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, 1920, 1080);
        ctx.save();
        ctx.globalAlpha = 0.65;
        ctx.filter = "blur(24px)";
        const scale = Math.max(2080 / image.width, 1200 / image.height);
        ctx.drawImage(
          image,
          (1920 - image.width * scale) / 2,
          (1080 - image.height * scale) / 2,
          image.width * scale,
          image.height * scale,
        );
        ctx.restore();
        const crop = Math.min(image.width, image.height);
        ctx.drawImage(
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
        const i = intervals.findIndex(
          (v) => seconds >= v.start && seconds < v.end,
        );
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
      },
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
      const count = localIntervals(project.sources).length;
      const labels = project.names.replace(/\r\n?/g, "\n").split("\n");
      if (labels.length !== count || labels.some((label) => !label.trim()))
        return `Version名は${count}行必要です。1つの素材に複数の名前を付ける場合は、Version境界を設定してください。`;
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
        project.cropTop + project.cropBottom >= source.height
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
