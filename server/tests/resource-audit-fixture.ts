// Explicitly offline: synthetic media only, no DB, providers or user files.
// Invoked by scripts/resource-audit/run.py, never shipped with the worker.
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mediaProcess, probe } from "../worker/render/process";
import {
  renderExport,
  exportFileHash,
  projectFor,
  snapshotFor,
} from "../cloud-export/render";
import {
  projectPlan,
  prepareGraphics,
  encodeProjectSegment,
} from "../worker/templates/all-versions/render";
import {
  prepareFnf,
  encodeFnfSegment,
} from "../worker/templates/fnf-showcase/render";
import { renderPlan } from "../worker/render/plan";
import { assemble } from "../worker/render/encode";
import { validateVideo } from "../worker/validation/output";
import { runWorker } from "../worker/runtime/service";
import { defaultFnfPreferences } from "../../src/domain/video/fnf-showcase";
import { FnfSession } from "../../src/services/video/fnf-session";
import {
  EXPORT_PROFILE,
  EXPORT_RENDERER,
  EXPORT_FONT_HASH,
} from "../../src/domain/cloud-export/schema";

const [
  mode,
  secondsText,
  background = "simple",
  titleText = "1",
  segmentText = "60",
  layout = "provisional-v1",
] = process.argv.slice(2);
const seconds = Number(secondsText),
  titles = Number(titleText),
  segmentFrames = Number(segmentText);
if (
  !["legacy", "unified", "render", "fnf"].includes(mode) ||
  ![1, 5, 15, 30].includes(seconds) ||
  ![1, 2, 3].includes(titles) ||
  ![60, 300, 1800].includes(segmentFrames) ||
  !["simple", "complex"].includes(background) ||
  !["provisional-v1", "reference-pasa-v1"].includes(layout)
)
  throw Error("Invalid diagnostic fixture");
const root = process.env.VIDEO_RENDER_DISK,
  audit = process.env.RESOURCE_AUDIT_DIR;
if (!root || !audit || !resolve(root).startsWith(resolve(audit) + "/"))
  throw Error("Isolated directories required");
await mkdir(root, { recursive: true });
const stage = async (name: string) =>
  appendFile(
    join(audit, "stages.jsonl"),
    JSON.stringify({
      name,
      t: performance.now(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
    }) + "\n",
  );
if (!["true", "false"].includes(process.env.VIDEO_RENDER_STATIC_COMPOSITE ?? ""))
  throw Error("Explicit true/false required");
await writeFile(join(audit, "effective-node.json"), JSON.stringify({staticComposite: process.env.VIDEO_RENDER_STATIC_COMPOSITE, layout}));
await stage("startup-no-db");
const stop = new AbortController();
const source = join(root, "synthetic.mp4"),
  coverPath = join(root, "synthetic.png");
await stage("synthetic-material-preparation");
await mediaProcess("ffmpeg", [
  "-f",
  "lavfi",
  "-i",
  `testsrc2=size=1920x1080:rate=60:duration=${seconds}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-threads:v",
  "1",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-colorspace",
  "bt709",
  "-c:a",
  "aac",
  "-ac",
  "2",
  "-ar",
  "48000",
  "-y",
  source,
]);
await mediaProcess("ffmpeg", [
  "-f",
  "lavfi",
  "-i",
  background === "simple"
    ? "color=c=blue:s=1920x1080"
    : "testsrc2=size=1920x1080",
  "-frames:v",
  "1",
  "-threads",
  "1",
  "-y",
  coverPath,
]);
const hash = await exportFileHash(source),
  cover = {
    blobId: "cover",
    path: coverPath,
    hash: await exportFileHash(coverPath),
  };
const markersUs = Array.from({ length: titles - 1 }, (_, i) =>
  Math.round(((i + 1) * seconds * 1e6) / titles),
);
// StoredSpec's legacy type restricts layout to provisional-v1; this offline
// fixture validates both layouts above and exercises the existing runtime
// conversion unchanged. This assertion emits no code and does not widen the API.
const spec = {
  schemaVersion: 1 as const,
  clips: [{ blobId: "clip", startUs: 0, endUs: seconds * 1e6, markersUs }],
  names: Array.from({ length: titles }, (_, i) => `Synthetic ${i + 1}`),
  coverBlobId: "cover",
  design: {
    height: EXPORT_PROFILE.height,
    fadeInFrames: 9,
    fadeOutFrames: 9,
    fontHash: EXPORT_FONT_HASH,
    rendererVersion: EXPORT_RENDERER,
    layout: layout as "provisional-v1" | "reference-pasa-v1",
  },
} as unknown as Parameters<typeof projectFor>[0];
const jobId = "00000000-0000-4000-8000-000000000001";
const inputs = [{ path: source, info: await probe(source) }];
await writeFile(join(audit, "input.json"), JSON.stringify({hash, coverHash: cover.hash, spec, segmentFrames}));
await stage("material-validation-complete");
const work = async () => {
  if (mode === "legacy" || mode === "unified") {
    await stage("legacy-render-start");
    const output = await renderExport({
      jobId,
      spec,
      directory: root,
      sources: [{ blobId: "clip", path: source, hash }],
      cover,
      segmentFrames,
      signal: stop.signal,
      onProgress: async () => {
        await stage("segment-validation-complete");
      },
    });
    await writeFile(
      join(audit, "result.json"),
      JSON.stringify(output.validation, null, 2),
    );
  } else {
    const snapshot = snapshotFor(spec, jobId, [
      { blobId: "clip", hash, durationUs: seconds * 1e6 },
    ]);
    const project = projectFor(spec, jobId, snapshot, cover);
    const prefs = defaultFnfPreferences();
    prefs.username = "@synthetic";
    const session = new FnfSession({
      reference: {
        libraryId: "cloud",
        fileId: "clip",
        versionId: "v",
        hash,
        kind: "video",
      },
      durationUs: seconds * 1e6,
      width: 1920,
      height: 1080,
      geometryVerified: true,
    });
    session.name(session.ranges[0].id, "synthetic");
    const plan =
      mode === "fnf"
        ? renderPlan(session.snapshot(prefs), 0, "fnf", segmentFrames)
        : projectPlan(project, snapshot, segmentFrames);
    await stage("background-or-overlay-generation");
    const graphics =
      mode !== "fnf"
        ? await prepareGraphics(project, coverPath, root)
        : undefined;
    const overlay = mode === "fnf" ? await prepareFnf(prefs, root) : undefined;
    await stage("graphics-complete");
    const paths = [];
    for (const segment of plan.segments) {
      const path = join(root, `segment-${segment.index}.mp4`);
      const version = Math.min(titles - 1, Math.floor(segment.outputStartFrame / (seconds * 60 / titles)));
      const versionStart = Math.round(version * seconds * 60 / titles);
      const versionEnd = Math.round((version + 1) * seconds * 60 / titles);
      const eligible = segment.outputStartFrame - versionStart >= 9 &&
        segment.outputStartFrame + segment.frames <= versionEnd - 9;
      const evidence = {segment: segment.index, version, start: segment.outputStartFrame,
        frames: segment.frames, versionStart, versionEnd, fadeIn: 9, fadeOut: 9, eligible,
        enabled: process.env.VIDEO_RENDER_STATIC_COMPOSITE, layout,
        cacheBefore: graphics?.staticComposites.get(version) ?? null};
      await appendFile(join(audit, "segments.jsonl"), JSON.stringify({event: "begin", ...evidence}) + "\n");
      await stage("title-and-segment-encode");
      if (overlay)
        await encodeFnfSegment(
          inputs[0],
          segment,
          plan,
          prefs,
          overlay,
          path,
          stop.signal,
        );
      else
        await encodeProjectSegment(
          project,
          segment,
          plan,
          graphics!,
          root,
          path,
          stop.signal,
        );
      await appendFile(join(audit, "segments.jsonl"), JSON.stringify({event: "encoded", ...evidence,
        cacheAfter: graphics?.staticComposites.get(version) ?? null}) + "\n");
      await stage("segment-validation");
      await validateVideo(
        path,
        { ...plan, frames: segment.frames },
        stop.signal,
      );
      paths.push(path);
    }
    await stage("concat-audio-mux");
    const output = await assemble(plan, inputs, paths, root, stop.signal, true);
    await stage("final-validation");
    const validation = await validateVideo(
      output.path,
      { ...plan, audio: true },
      stop.signal,
    );
    await writeFile(
      join(audit, "result.json"),
      JSON.stringify(validation, null, 2),
    );
  }
  await stage("render-complete-no-publish-no-cleanup");
};
if (mode === "unified")
  await runWorker(
    [{ name: "synthetic-export", enabled: () => true, run: work }],
    stop.signal,
    {
      pause: async () => stop.abort(),
      onError: () => {
        process.exitCode = 1;
        stop.abort();
      },
    },
  );
else await work();
await stage("idle");
await new Promise((r) => setTimeout(r, 250));
await stage("idle-end");
