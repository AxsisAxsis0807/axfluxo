import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { newProject } from "../../src/domain/video/all-versions";
import { defaultFnfPreferences } from "../../src/domain/video/fnf-showcase";
import { FnfSession } from "../../src/services/video/fnf-session";
import { buildCloudLocalJobs, restoreCloudLocalJob, type CloudLocalRecipe } from "../../src/services/video/cloud-local-job";
import { ExportQueue, type ExportEntry } from "../../src/services/video/export-queue";
import { saveExportEntries, loadExportEntries } from "../../src/services/video/recovery-store";
import type { AuthenticatedApi } from "../../src/services/cloud-library/client";

const ownerId = "11111111-1111-4111-8111-111111111111";
const reference = { libraryId: "library", fileId: "source", versionId: "immutable-version", hash: "a".repeat(64), kind: "video" as const };
function recipes(): CloudLocalRecipe[] {
  const session = new FnfSession({ reference, durationUs: 4_000_000, width: 160, height: 90, geometryVerified: true });
  session.name(session.ranges[0].id, "FIRST");
  session.edit(session.ranges[0].id, 0, 1_000_000);
  const second = session.addAt(2_000_000);
  session.name(second.id, "SECOND");
  const snapshot = session.snapshot(defaultFnfPreferences());
  const project = newProject();
  project.document = session.document();
  project.cover = { ...reference, fileId: "cover", versionId: "cover-version", kind: "image" };
  project.namesText = "ORIGINAL";
  project.design.height = 1440;
  return [
    { version: 1, kind: "all-versions", ownerId, index: 0, project },
    { version: 1, kind: "fnf-showcase", ownerId, index: 1, snapshot, width: 160, height: 90 },
  ];
}
it("persists both cloud recipes without live functions, credentials or network hydration", async () => {
  const data = recipes();
  const inputs = data.map(restoreCloudLocalJob);
  const q = new ExportQueue(async () => { throw Error("must not run"); });
  q.pause();
  q.enqueue(inputs, true);
  await saveExportEntries(q.getSnapshot().entries);
  const rows = await loadExportEntries();
  expect(rows.map(r => r.cloudRecovery)).toEqual(data);
  expect(rows.map(r => r.input?.needsCloudRebuild)).toEqual([true, true]);
  expect(rows[0].input?.height).toBe(1440);
  expect(rows[1].input?.pieces[0].start).toBe(2);
  expect(rows[1].filename).toBe(inputs[1].filename);
  expect(rows[1].state).toBe("queued");
  expect(JSON.stringify(rows)).not.toMatch(/access_token|https:\/\//);
  await saveExportEntries([]);
});
it("takes a detached snapshot and refuses a different account before requesting private assets", async () => {
  const [recipe] = recipes();
  const job = restoreCloudLocalJob(recipe);
  if (recipe.kind !== "all-versions") throw Error("fixture");
  recipe.project.namesText = "EDITED";
  expect(job.cloudRecovery?.kind === "all-versions" && job.cloudRecovery.project.namesText).toBe("ORIGINAL");
  const request = vi.fn();
  const api = { me: async () => ({ ok: true, data: { ownerId: "another-owner" } }), request } as unknown as AuthenticatedApi;
  await expect(buildCloudLocalJobs(job.cloudRecovery!, api)).rejects.toThrow("予約したアカウント");
  expect(request).not.toHaveBeenCalled();
});
it("keeps old rows and completed output compatible with the new cloud recipe", async () => {
  const [recipe] = recipes();
  const base: ExportEntry = { id: "cloud", filename: "saved.mp4", state: "completed", progress: 1, message: "done", rest: false, cloudRecovery: recipe, result: { filename: "saved.mp4", blob: new Blob(["saved"]) } };
  await saveExportEntries([base, { ...base, id: "legacy", cloudRecovery: undefined, result: undefined, state: "rendering" }]);
  const rows = await loadExportEntries();
  expect(rows[0].state).toBe("completed");
  expect(await rows[0].result?.blob.text()).toBe("saved");
  expect(rows[1].state).toBe("failed");
  await saveExportEntries([]);
});
