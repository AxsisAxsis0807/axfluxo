import { describe, it, expect, vi } from "vitest";
import {
  multipartLayout,
  MiB,
  PROVIDER_LIMITS,
  accessSchema,
} from "../../src/domain/cloud-library/media";
import {
  hashBlob,
  listResumes,
  saveResume,
  uploadFile,
  UploadError,
  type ResumeStorage,
} from "../../src/services/cloud-library/upload";
import type { CloudClient } from "../../src/services/cloud-library/client";
class MemoryStorage implements ResumeStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return Array.from(this.map.keys())[i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
const owner = "11111111-1111-4111-8111-111111111111",
  id = "22222222-2222-4222-8222-222222222222";
describe("bounded browser upload and reselection", () => {
  it("uses 16MiB initially and grows parts to obey provider count limits", () => {
    expect(multipartLayout(64 * MiB)).toEqual({
      partSize: 16 * MiB,
      partCount: 4,
    });
    const layout = multipartLayout(200 * 1024 * MiB);
    expect(layout.partSize).toBeGreaterThan(16 * MiB);
    expect(layout.partCount).toBeLessThanOrEqual(PROVIDER_LIMITS.maxParts);
    expect(multipartLayout(20 * MiB, 1).partSize).toBe(20 * MiB);
    expect(() => multipartLayout(0)).toThrow();
  });
  it("hashes with File.slice and never loads a large File into ArrayBuffer", async () => {
    const file = new File([new Uint8Array(7 * MiB)], "large.mp4", {
      type: "video/mp4",
    });
    const full = vi
      .spyOn(file, "arrayBuffer")
      .mockRejectedValue(new Error("full-file read forbidden"));
    const slice = vi.spyOn(file, "slice");
    const digest = await hashBlob(file);
    expect(digest.sha256).toHaveLength(64);
    expect(digest.md5).toHaveLength(32);
    expect(full).not.toHaveBeenCalled();
    expect(slice).toHaveBeenCalledTimes(4);
    expect(
      slice.mock.calls.every(
        ([start, end]) => Number(end) - Number(start) <= 2 * MiB,
      ),
    ).toBe(true);
  });
  it("requires the original byte hash even for a same-name/same-size reselected File", async () => {
    const original = new File(["original"], "same.mp4", { type: "video/mp4" }),
      different = new File(["replaced"], "same.mp4", { type: "video/mp4" });
    const digest = await hashBlob(original),
      storage = new MemoryStorage();
    const resume = {
      schemaVersion: 1 as const,
      ownerId: owner,
      key: id,
      id,
      input: {
        folderId: null,
        name: original.name,
        size: original.size,
        mime: "video/mp4" as const,
        sha256: digest.sha256,
      },
    };
    const client = {
      me: async () => ({
        ok: true,
        state: "ready",
        data: { ownerId: owner, membership: "developer" },
      }),
      status: vi.fn(),
      sign: vi.fn(),
    } as unknown as CloudClient;
    await expect(
      uploadFile({
        client,
        file: different,
        ownerId: owner,
        folderId: null,
        storage,
        resume,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_FILE_MISMATCH" });
    expect(client.status).not.toHaveBeenCalled();
    expect(client.sign).not.toHaveBeenCalled();
  });
  it("preserves only owner-scoped resume hints and excludes secrets and signed URLs", async () => {
    const storage = new MemoryStorage(),
      digest = await hashBlob(new Blob(["bytes"]));
    saveResume(storage, {
      schemaVersion: 1,
      ownerId: owner,
      key: id,
      id: null,
      input: {
        folderId: null,
        name: "x.mp4",
        size: 5,
        mime: "video/mp4",
        sha256: digest.sha256,
      },
    });
    expect(listResumes(storage, owner)).toHaveLength(1);
    expect(listResumes(storage, id)).toEqual([]);
    expect(Array.from(storage.map.values()).join()).not.toMatch(
      /https:|Bearer|access_token/,
    );
    expect(
      accessSchema.safeParse({ url: "javascript:alert(1)", expiresAt: 0 })
        .success,
    ).toBe(false);
  });
  it("stops on background/tab cancellation without inventing completion", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      hashBlob(new File(["bytes"], "x.mp4"), controller.signal),
    ).rejects.toBeInstanceOf(UploadError);
  });
  it("reports signature expiry separately and keeps a resumable record", async () => {
    const file = new File(["small"], "x.mp4", { type: "video/mp4" }),
      digest = await hashBlob(file),
      storage = new MemoryStorage();
    const view = {
      id,
      ownerId: owner,
      name: "x.mp4",
      size: file.size,
      sha256: digest.sha256,
      partSize: 16 * MiB,
      partCount: 1,
      state: "uploading",
      parts: [],
      error: null,
      assetId: null,
      versionId: null,
    };
    const ok = (data: unknown) => ({ ok: true, state: "ready", data });
    const client = {
      me: async () => ok({ ownerId: owner, membership: "developer" }),
      start: async () => ok(view),
      sign: async () =>
        ok({
          url: "https://storage.test/part",
          headers: {},
          expiresAt: Date.now() + 1000,
        }),
      complete: vi.fn(),
    } as unknown as CloudClient;
    await expect(
      uploadFile({
        client,
        file,
        ownerId: owner,
        folderId: null,
        storage,
        transport: async () => new Response(null, { status: 403 }),
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_SIGNATURE_EXPIRED" });
    expect(client.complete).not.toHaveBeenCalled();
    expect(listResumes(storage, owner)[0].id).toBe(id);
  });
});
