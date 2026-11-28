import { z } from "zod";
import { allVersionsProjectSchema, projectIssues, projectNames, versionIntervals, textAlpha } from "../../domain/video/all-versions";
import { fnfShowcaseSnapshotSchema } from "../../domain/video/fnf-showcase";
import { cloudClient, type AuthenticatedApi } from "../cloud-library/client";
import { createVideoApiClient, currentVideoSessionSource } from "./api-client";
import { projectsClient } from "./projects-client";
import { fnfClient } from "./fnf-client";
import { imageForEncode, type LocalEncodeJob } from "./local-encode";
import {
  drawAllVersionsCover,
  drawReferenceFrame,
  loadReferenceFonts,
  referenceArtwork,
  referenceCanvasTitle,
} from "./all-versions-canvas";

// Only immutable version references and rendering settings are persisted.
// Never store access URLs, bearer tokens, decoded media or editor state.
const base = { version: z.literal(1), ownerId: z.string().min(1), index: z.number().int().nonnegative() };
export const cloudLocalRecipeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("all-versions"), project: allVersionsProjectSchema, index: z.literal(0) }),
  z.strictObject({ ...base, kind: z.literal("fnf-showcase"), snapshot: fnfShowcaseSnapshotSchema,
    width: z.number().int().positive(), height: z.number().int().positive() }),
]);
export type CloudLocalRecipe = z.infer<typeof cloudLocalRecipeSchema>;
export type RecoverableLocalJob = LocalEncodeJob & {
  cloudRecovery?: CloudLocalRecipe;
  needsCloudRebuild?: boolean;
};

function validateRecipe(value: CloudLocalRecipe): CloudLocalRecipe {
  const recipe = cloudLocalRecipeSchema.parse(value);
  if (recipe.kind === "all-versions") {
    if (projectIssues(recipe.project).length) throw Error("素材と名前を確認してください。");
  } else if (recipe.index >= recipe.snapshot.ranges.length) {
    throw Error("復旧するジョブが不正です。");
  }
  return recipe;
}

/** Rehydrate without network or auth; a job can be retried after login, and
 * a temporarily unavailable cloud asset must not prevent other jobs loading. */
export function restoreCloudLocalJob(value: CloudLocalRecipe): RecoverableLocalJob {
  const recipe = validateRecipe(value);
  const fail = () => { throw Error("クラウド素材の再構築が必要です。"); };
  const piece = (startUs: number, endUs: number) => ({ start: startUs / 1e6, end: endUs / 1e6, url: async () => fail() });
  const common = { cloudRecovery: recipe, needsCloudRebuild: true, draw: fail };
  if (recipe.kind === "all-versions") {
    const height = recipe.project.design.height;
    return { ...common, filename: "All Versions.mp4", timestamped: true, width: height * 16 / 9, height,
      pieces: recipe.project.document!.clips.map(c => piece(c.interval.startUs, c.interval.endUs)) };
  }
  const range = recipe.snapshot.ranges[recipe.index];
  return { ...common, filename: recipe.snapshot.names[recipe.index], width: 1080, height: 1920,
    pieces: [piece(range.startUs, range.endUs)] };
}

export async function buildCloudLocalJobs(value: CloudLocalRecipe, injected?: AuthenticatedApi): Promise<RecoverableLocalJob[]> {
  // Parse creates a detached snapshot before the first asynchronous operation.
  const recipe = validateRecipe(value);
  let api = injected;
  if (!api) {
    const session = currentVideoSessionSource(), baseUrl = process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
    if (!session || !baseUrl) throw Error("クラウド素材の復旧にはログインと動画APIが必要です。");
    api = createVideoApiClient({ session, baseUrl });
  }
  const auth = api;
  const cloud = cloudClient(auth);
  const checkOwner = async () => {
    const membership = await auth.me();
    if (!membership.ok || membership.data.ownerId !== recipe.ownerId)
      throw Error("予約したアカウントでログインして再試行してください。");
  };
  await checkOwner();
  const access = async (versionId: string) => {
    await checkOwner();
    const r = await cloud.access(versionId);
    if (!r.ok) throw Error(r.code);
    return r.data.url;
  };
  if (recipe.kind === "all-versions") {
    const project = recipe.project;
    if (!project.document) throw Error("素材と名前を確認してください。");
    const remote = projectsClient(auth, recipe.ownerId);
    const reference = project.design.layout === "reference-pasa-v1";
    const names = projectNames(project), versions = versionIntervals(project);
    const cover = project.cover ? await imageForEncode(await access(project.cover.versionId)) : null;
    if (!reference && !cover) throw Error("カバー画像を選択してください。");
    const overlays: HTMLImageElement[] = [];
    if (reference) await loadReferenceFonts(names);
    else for (let i = 0; i < versions.length; i++) {
      const r = await remote.text(project, i);
      overlays.push(await imageForEncode(`data:image/png;base64,${r.png}`));
    }
    const drawTitle = reference ? referenceCanvasTitle(names) : null;
    const height = project.design.height,
      width = (height * 16) / 9;
    const artwork = reference ? await referenceArtwork(cover, width, height) : null;
    return [
      {
        cloudRecovery: recipe,
        filename: "All Versions.mp4",
        timestamped: true,
        width,
        height,
        pieces: project.document.clips.map((c) => ({
          start: c.interval.startUs / 1e6,
          end: c.interval.endUs / 1e6,
          url: () => access(c.source.versionId),
        })),
        draw: (ctx, _media, seconds) => {
          if (artwork && drawTitle) {
            drawReferenceFrame(ctx, artwork, Math.round(seconds * 60), versions,
              project.design, drawTitle);
            return;
          }
          if (!cover) return;
          ctx.save();
          ctx.scale(width / 1920, height / 1080);
          ctx.fillStyle = "black";
          ctx.fillRect(0, 0, 1920, 1080);
          ctx.save();
          ctx.filter = "blur(24px)";
          ctx.globalAlpha = 0.7;
          const scale = Math.max(2150 / cover.width, 1210 / cover.height);
          ctx.drawImage(
            cover,
            (1920 - cover.width * scale) / 2,
            (1080 - cover.height * scale) / 2,
            cover.width * scale,
            cover.height * scale,
          );
          ctx.restore();
          const size = 605;
          drawAllVersionsCover(ctx, cover, (1920 - size) / 2, 130, size);
          ctx.fillStyle = "rgba(0,0,0,.48)";
          ctx.fillRect(96, 842, 1728, 162);
          const frame = Math.floor(seconds * 60),
            i = versions.findIndex(
              (v) => frame >= v.startFrame && frame < v.endFrame,
            );
          if (i >= 0) {
            ctx.globalAlpha = textAlpha(frame, versions[i], project.design);
            ctx.drawImage(overlays[i], 0, 0, 1920, 1080);
          }
          ctx.restore();
        },
      },
    ];
  } else {
    const snapshot = recipe.snapshot, client = fnfClient(auth, recipe.ownerId);
    const result = await client.overlay(snapshot.preferences);
    if (!result.ok) throw Error(result.code);
    const overlay = await imageForEncode(
      `data:image/png;base64,${result.data.png}`,
    );
    const source = { width: recipe.width, height: recipe.height, reference: snapshot.document.clips[0].source },
      template = snapshot.preferences.template;
    return snapshot.ranges.map((range, i) => ({
      cloudRecovery: { ...recipe, index: i },
      filename: snapshot.names[i],
      width: 1080,
      height: 1920,
      pieces: [
        {
          start: range.startUs / 1e6,
          end: range.endUs / 1e6,
          url: () => access(source.reference.versionId),
        },
      ],
      draw: (ctx, media) => {
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, 1080, 1920);
        const croppedHeight =
          source.height - template.cropTop - template.cropBottom;
        if (croppedHeight <= 0) throw Error("cropを確認してください。");
        const w = source.width * template.scale,
          h = croppedHeight * template.scale;
        ctx.drawImage(
          media,
          0,
          template.cropTop,
          source.width,
          croppedHeight,
          (1080 - w) / 2,
          (1920 - h) / 2,
          w,
          h,
        );
        ctx.drawImage(overlay, 0, 0, 1080, 1920);
      },
    }));
  }
}

/** Shared by the queue runner and the reload regression. */
export async function rebuildCloudLocalJob(job: RecoverableLocalJob, api?: AuthenticatedApi): Promise<RecoverableLocalJob> {
  if (!job.needsCloudRebuild) return job;
  if (!job.cloudRecovery) throw Error("復旧するジョブが不正です。");
  const jobs = await buildCloudLocalJobs(job.cloudRecovery, api);
  const next = jobs[job.cloudRecovery.index];
  if (!next) throw Error("復旧するジョブが不正です。");
  return next;
}
