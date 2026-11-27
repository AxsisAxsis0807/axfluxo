import { newProject } from "../../../src/domain/video/all-versions";
import { defaultFnfPreferences } from "../../../src/domain/video/fnf-showcase";
import { FnfSession } from "../../../src/services/video/fnf-session";
import { buildCloudLocalJobs, rebuildCloudLocalJob, type CloudLocalRecipe, type RecoverableLocalJob } from "../../../src/services/video/cloud-local-job";
import { localExportQueue, reserveLocalExports } from "../../../src/services/video/local-export-runtime";
import { acquireStartupRecoveryLease, loadExportEntries } from "../../../src/services/video/recovery-store";
import type { AuthenticatedApi } from "../../../src/services/cloud-library/client";

const ownerId = "11111111-1111-4111-8111-111111111111";
const reference = { libraryId: "library", fileId: "video", versionId: "video-v1", hash: "a".repeat(64), kind: "video" as const };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function apiFor(generation: string) {
  return {
    me: async () => ({ ok: true, data: { ownerId } }),
    request: async (path: string) => {
      if (path.endsWith("/access")) {
        const file = path.includes("cover-v1") ? "cover.png" : "video.mp4";
        return { ok: true, data: { url: location.origin + "/" + file + "?generation=" + generation } };
      }
      if (path === "/projects/text-preview" || path === "/fnf-showcase/overlay")
        return { ok: true, data: { png } };
      throw Error("Unexpected API " + path);
    },
  } as unknown as AuthenticatedApi;
}
function recipes(): CloudLocalRecipe[] {
  const session = new FnfSession({ reference, durationUs: 4_000_000, width: 160, height: 90, geometryVerified: true });
  session.name(session.ranges[0].id, "FIRST");
  session.edit(session.ranges[0].id, 0, 1_000_000);
  session.name(session.addAt(2_000_000).id, "SECOND");
  const prefs = defaultFnfPreferences();
  prefs.template.presetWidth = 160;
  prefs.template.presetHeight = 90;
  prefs.template.cropTop = 4;
  prefs.template.cropBottom = 5;
  prefs.template.scale = 6.75;
  const project = newProject();
  project.document = session.document();
  project.cover = { ...reference, fileId: "cover", versionId: "cover-v1", kind: "image" };
  project.namesText = "ORIGINAL";
  const provisional = { ...project, id: crypto.randomUUID(),
    design: { ...project.design, layout: "provisional-v1" as const, height: 1440 as const } };
  return [
    { version: 1, kind: "all-versions", ownerId, index: 0, project },
    { version: 1, kind: "all-versions", ownerId, index: 0, project: provisional },
    { version: 1, kind: "fnf-showcase", ownerId, index: 0, snapshot: session.snapshot(prefs), width: 160, height: 90 },
  ];
}
async function describe(job: RecoverableLocalJob) {
  const media = document.createElement("canvas");
  media.width = 160; media.height = 90;
  const mc = media.getContext("2d")!;
  mc.fillStyle = "#2d8aab"; mc.fillRect(0, 0, 160, 90);
  mc.fillStyle = "#ffe000"; mc.fillRect(20, 20, 40, 40);
  const canvas = document.createElement("canvas");
  canvas.width = job.width; canvas.height = job.height;
  job.draw(canvas.getContext("2d")!, media as unknown as HTMLVideoElement, 0.5);
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, job.width, job.height).data;
  const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(pixels))), x => x.toString(16).padStart(2, "0")).join("");
  const url = await job.pieces[0].url();
  return { filename: job.filename, width: job.width, height: job.height, checksum,
    pieces: job.pieces.map(({ start, end }) => ({ start, end })), url };
}
async function reserveCloudFixture() {
  const jobs: RecoverableLocalJob[] = [];
  for (const recipe of recipes()) jobs.push(...await buildCloudLocalJobs(recipe, apiFor("before")));
  // Pause exactly as the real queue does when reservations are waiting.
  localExportQueue.pause();
  await reserveLocalExports(jobs, true);
  return Promise.all(jobs.map(describe));
}
async function restoreCloudFixture() {
  await acquireStartupRecoveryLease(new AbortController().signal, () => {});
  const rows = await loadExportEntries();
  const descriptions = [];
  for (const row of rows) {
    if (row.state !== "queued" || !row.input?.needsCloudRebuild) throw Error("Missing durable input");
    descriptions.push(await describe(await rebuildCloudLocalJob(row.input, apiFor("after"))));
  }
  return descriptions;
}
Object.assign(window, { reserveCloudFixture, restoreCloudFixture });
