import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import {
  saveProject,
  get,
  ConflictError,
  all,
  SaveQueue,
} from "../src/services/storage";
import { newProject } from "../src/domain/document";
describe("IndexedDB CAS", () => {
  it("does not silently overwrite another tab and preserves recovery revisions", async () => {
    const d = newProject();
    await saveProject(d, null);
    const a = { ...d, revision: 1, name: "tab A" };
    await saveProject(a, 0);
    await expect(
      saveProject({ ...d, revision: 1, name: "tab B" }, 0),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await get<typeof d>("projects", d.id))?.name).toBe("tab A");
    expect((await all("revisions")).length).toBeGreaterThan(0);
  });
  it("serial queue survives errors in previous writes", async () => {
    const q = new SaveQueue();
    const result: number[] = [];
    await expect(
      q.enqueue(async () => {
        throw Error("quota");
      }),
    ).rejects.toThrow("quota");
    await q.enqueue(async () => {
      result.push(1);
    });
    expect(result).toEqual([1]);
  });
});
it("template versions are immutable and concurrent version updates conflict", async () => {
  const { saveTemplateVersion } = await import("../src/services/storage");
  const { uid } = await import("../src/domain/document");
  const root = uid();
  const t = {
    id: uid(),
    templateId: root,
    name: "template",
    description: "",
    version: 1,
    document: newProject(),
    createdAt: new Date().toISOString(),
  };
  await saveTemplateVersion(t, 0);
  await saveTemplateVersion({ ...t, id: uid(), version: 2, name: "next" }, 1);
  await expect(
    saveTemplateVersion({ ...t, id: uid(), version: 2, name: "other" }, 1),
  ).rejects.toThrow("別タブ");
  const versions = await all<typeof t>("templates");
  expect(versions.filter((v) => v.templateId === root)).toHaveLength(2);
  expect((await get<typeof t>("templates", t.id))?.name).toBe("template");
});
