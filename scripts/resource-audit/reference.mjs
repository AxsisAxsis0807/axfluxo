// Offline reference-layout quality comparison; preserves synthetic outputs.
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { newProject } from "../../src/domain/video/all-versions.ts";
import { allVersionsDocumentSchema } from "../../src/domain/video/schema.ts";
import { mediaProcess, probe } from "../../server/worker/render/process.ts";
import { validateVideo } from "../../server/worker/validation/output.ts";
if (!process.argv[2] || !process.argv[3])
  throw Error(
    "Usage: node --import tsx scripts/resource-audit/reference.mjs BASELINE_CHECKOUT NEW_OUTPUT_DIR",
  );
const root = resolve(process.argv[3]);
await mkdir(root, { recursive: false });
const source = root + "/synthetic.wav",
  cover = root + "/synthetic.png";
await mediaProcess("ffmpeg", [
  "-f",
  "lavfi",
  "-i",
  "sine=sample_rate=48000:duration=5",
  "-y",
  source,
]);
await mediaProcess("ffmpeg", [
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=1920x1080",
  "-frames:v",
  "1",
  "-threads",
  "1",
  "-y",
  cover,
]);
const results = [];
for (const [version, repo] of [
  ["baseline", resolve(process.argv[2])],
  ["candidate", process.cwd()],
]) {
  const { projectPlan, prepareGraphics, encodeProjectSegment } = await import(
    repo + "/server/worker/templates/all-versions/render.ts"
  );
  const { assemble } = await import(repo + "/server/worker/render/encode.ts");
  const p = newProject();
  p.design.layout = "reference-pasa-v1";
  p.design.fadeInFrames = 9;
  p.design.fadeOutFrames = 9;
  p.cover = {
    libraryId: "cloud",
    fileId: "synthetic",
    versionId: "v",
    hash: "a".repeat(64),
    kind: "image",
  };
  p.namesText = "Synthetic One\nSynthetic Two";
  p.document = allVersionsDocumentSchema.parse({
    schemaVersion: 1,
    kind: "all-versions",
    id: "synthetic",
    revision: 0,
    fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
    clips: [
      {
        id: "c",
        source: { ...p.cover, kind: "audio" },
        sourceDurationUs: 5000000,
        interval: { startUs: 0, endUs: 5000000 },
        markersUs: [2500000],
      },
    ],
  });
  const snapshot = {
    schemaVersion: 1,
    id: "s",
    document: p.document,
    ranges: [{ startUs: 0, endUs: 5000000 }],
    names: ["synthetic.mp4"],
  };
  const plan = projectPlan(p, snapshot, 60),
    dir = root + "/" + version;
  await mkdir(dir, { recursive: true });
  const graphics = await prepareGraphics(p, cover, dir),
    paths = [];
  for (const s of plan.segments) {
    const path = dir + "/segment-" + s.index + ".mp4";
    await encodeProjectSegment(p, s, plan, graphics, dir, path);
    paths.push(path);
  }
  const output = await assemble(
    plan,
    [{ path: source, info: await probe(source) }],
    paths,
    dir,
    undefined,
    true,
  );
  const v = await validateVideo(output.path, { ...plan, audio: true });
  results.push({ version, validation: v });
  await writeFile(root + "/results.json", JSON.stringify(results, null, 2));
}
console.log(
  JSON.stringify({
    identical:
      JSON.stringify(results[0].validation) ===
      JSON.stringify(results[1].validation),
    results,
  }),
);
