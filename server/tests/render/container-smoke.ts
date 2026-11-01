// Offline Docker runtime verification. Not shipped or invoked by the worker.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { mediaProcess, probe } from "../../worker/render/process";
import { renderPlan } from "../../worker/render/plan";
import { encodeSegment, assemble } from "../../worker/render/encode";
import { validateVideo } from "../../worker/validation/output";
import { fnfSnapshotSchema } from "../../../src/domain/video/schema";
if (process.getuid?.() === 0) throw new Error("Expected non-root");
const dir = process.env.VIDEO_RENDER_DISK!;
await mkdir(dir, { recursive: true });
const path = join(dir, "source.mp4");
await mediaProcess("ffmpeg", [
  "-nostdin",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=160x90:rate=60:duration=1",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=48000:duration=1",
  "-c:v",
  "libx264",
  "-threads",
  "1",
  "-c:a",
  "aac",
  "-ac",
  "2",
  "-y",
  path,
]);
const snapshot = fnfSnapshotSchema.parse({
  schemaVersion: 1,
  id: "s",
  document: {
    schemaVersion: 1,
    kind: "all-versions",
    id: "d",
    revision: 0,
    fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
    clips: [
      {
        id: "c",
        source: {
          libraryId: "cloud",
          fileId: "f",
          versionId: "v",
          hash: "a".repeat(64),
          kind: "video",
        },
        sourceDurationUs: 1_000_000,
        interval: { startUs: 0, endUs: 1_000_000 },
        markersUs: [],
      },
    ],
  },
  ranges: [{ startUs: 0, endUs: 1_000_000 }],
  names: ["result.mp4"],
});
const input = { path, info: await probe(path) },
  results = [];
for (const mode of ["all-versions", "fnf"] as const) {
  const stage = join(dir, mode);
  await mkdir(stage, { recursive: true });
  const plan = renderPlan(snapshot, 0, mode, 30);
  plan.width = 160;
  plan.height = 90;
  const paths = [];
  for (const s of plan.segments) {
    const p = join(stage, `segment-${s.index}.mp4`);
    await encodeSegment(input, s, plan, p);
    await validateVideo(p, { ...plan, frames: s.frames });
    paths.push(p);
  }
  const result = await assemble(plan, [input], paths, stage),
    v = await validateVideo(result.path, { ...plan, audio: true });
  results.push({
    mode,
    audioMode: result.audioMode,
    frames: v.frames,
    sha256: v.sha256,
  });
}
process.stdout.write(
  JSON.stringify({
    uid: process.getuid?.(),
    memoryMax: (await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim(),
    results,
  }) + "\n",
);
