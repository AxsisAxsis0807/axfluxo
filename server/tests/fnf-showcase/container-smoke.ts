// Offline Linux runtime check. Synthetic gameplay only; no DB/cloud/network.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FnfSession } from "../../../src/services/video/fnf-session";
import { defaultFnfPreferences } from "../../../src/domain/video/fnf-showcase";
import { renderPlan } from "../../worker/render/plan";
import {
  prepareFnf,
  encodeFnfSegment,
} from "../../worker/templates/fnf-showcase/render";
import { assemble } from "../../worker/render/encode";
import { probe, mediaProcess } from "../../worker/render/process";
import { validateVideo } from "../../worker/validation/output";
const dir = process.env.VIDEO_RENDER_DISK!;
await mkdir(dir, { recursive: true });
const source = join(dir, "gameplay.mp4");
await mediaProcess("ffmpeg", [
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
  "-ar",
  "48000",
  "-y",
  source,
]);
const input = { path: source, info: await probe(source) },
  session = new FnfSession({
    reference: {
      libraryId: "cloud",
      fileId: "asset",
      versionId: "version",
      hash: "a".repeat(64),
      kind: "video",
    },
    durationUs: 1000000,
    width: 160,
    height: 90,
    geometryVerified: true,
  });
session.name(session.ranges[0].id, "日本語");
const r = session.addAt(0);
session.edit(r.id, 16667, 266667);
session.name(r.id, "日本語");
const p = defaultFnfPreferences();
p.username = "@日本語_user";
p.template = {
  ...p.template,
  presetWidth: 160,
  presetHeight: 90,
  scale: 1080 / 160,
};
const snapshot = session.snapshot(p),
  results = [];
for (let i = 0; i < snapshot.ranges.length; i++) {
  const stage = join(dir, `range-${i}`);
  await mkdir(stage, { recursive: true });
  const plan = renderPlan(snapshot, i),
    overlay = await prepareFnf(p, stage),
    paths = [];
  for (const segment of plan.segments) {
    const path = join(stage, `s${segment.index}.mp4`);
    await encodeFnfSegment(input, segment, plan, p, overlay, path);
    paths.push(path);
  }
  const output = await assemble(plan, [input], paths, stage, undefined, true);
  const validation = await validateVideo(output.path, { ...plan, audio: true });
  results.push({
    ...validation,
    audioMode: output.audioMode,
    filename: snapshot.names[i],
  });
}
await writeFile(join(dir, "result.json"), JSON.stringify(results));
process.stdout.write(
  JSON.stringify({ uid: process.getuid?.(), results }) + "\n",
);
