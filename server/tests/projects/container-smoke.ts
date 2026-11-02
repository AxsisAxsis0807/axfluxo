// Offline V5 runtime check. No DB or cloud, only synthetic local media.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  newProject,
  AV_RENDERER,
} from "../../../src/domain/video/all-versions";
import { allVersionsDocumentSchema } from "../../../src/domain/video/schema";
import { mediaProcess, probe } from "../../worker/render/process";
import {
  projectPlan,
  prepareGraphics,
  encodeProjectSegment,
} from "../../worker/templates/all-versions/render";
import { assemble } from "../../worker/render/encode";
import { validateVideo } from "../../worker/validation/output";
const dir = process.env.VIDEO_RENDER_DISK!;
await mkdir(dir, { recursive: true });
const source = join(dir, "audio.wav"),
  cover = join(dir, "cover.png");
await mediaProcess("ffmpeg", [
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=48000:duration=1",
  "-c:a",
  "pcm_s16le",
  "-y",
  source,
]);
await mediaProcess("ffmpeg", [
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=100x100",
  "-frames:v",
  "1",
  "-threads",
  "1",
  "-y",
  cover,
]);
const results = [];
for (const height of [1080, 1440] as const) {
  const p = newProject();
  p.cover = {
    libraryId: "cloud",
    fileId: "cover",
    versionId: "cv",
    hash: "a".repeat(64),
    kind: "image",
  };
  p.namesText = "Aleo";
  p.design.height = height;
  if (height === 1440) {
    p.design.fadeInFrames = 0;
    p.design.fadeOutFrames = 0;
  }
  const endUs = height === 1080 ? 400000 : 83333;
  p.document = allVersionsDocumentSchema.parse({
    schemaVersion: 1,
    kind: "all-versions",
    id: "d",
    revision: 0,
    fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
    clips: [
      {
        id: "c",
        source: { ...p.cover, kind: "audio" },
        sourceDurationUs: 1000000,
        interval: { startUs: 0, endUs },
        markersUs: [],
      },
    ],
  });
  const snapshot = {
      schemaVersion: 1 as const,
      id: "s",
      document: p.document,
      ranges: [{ startUs: 0, endUs }],
      names: ["output.mp4"],
    },
    plan = projectPlan(p, snapshot, 12),
    stage = join(dir, String(height));
  await mkdir(stage, { recursive: true });
  const graphics = await prepareGraphics(p, cover, stage),
    paths = [];
  for (const s of plan.segments) {
    const path = join(stage, `s${s.index}.mp4`);
    await encodeProjectSegment(p, s, plan, graphics, stage, path);
    paths.push(path);
  }
  const output = await assemble(
      plan,
      [{ path: source, info: await probe(source) }],
      paths,
      stage,
      undefined,
      true,
    ),
    validation = await validateVideo(output.path, { ...plan, audio: true });
  results.push(validation);
}
await writeFile(join(dir, "result.json"), JSON.stringify(results));
process.stdout.write(
  JSON.stringify({ uid: process.getuid?.(), renderer: AV_RENDERER, results }) +
    "\n",
);
