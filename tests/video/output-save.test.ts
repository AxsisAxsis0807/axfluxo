import { it, expect, vi } from "vitest";
import {
  prepareShare,
  sharePrepared,
  MAX_SHARE_BYTES,
  validOutputAccess,
} from "../../src/services/video/output-save";
import { batchCompletion } from "../../server/worker/notifications/service";
import {
  allowedPushEndpoint,
  saveConfirmationSchema,
} from "../../server/contracts/outputs";
import { deletionStorage } from "../../server/worker/deletion/storage";
it("never downloads a huge MP4 into memory", async () => {
  const f = vi.fn();
  await expect(
    prepareShare("https://test/file", MAX_SHARE_BYTES + 1, "a.mp4", f),
  ).rejects.toThrow("DIRECT_SAVE_REQUIRED");
  expect(f).not.toHaveBeenCalled();
});
it("enforces streaming size, filename separation and share cancellation without save acknowledgement", async () => {
  const f = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
  const file = await prepareShare("https://test/file", 3, "../日本語.mp4", f);
  expect(file.name).not.toContain("/");
  expect(file.size).toBe(3);
  const result = await sharePrepared(file, async () => {
    throw new DOMException("cancelled", "AbortError");
  });
  expect(result).toBe("cancelled");
  expect(await sharePrepared(file, async () => {})).toBe("shared");
  expect(
    saveConfirmationSchema.safeParse({
      versionId: "v",
      hash: "a".repeat(64),
      photoLibraryChecked: false,
    }).success,
  ).toBe(false);
  await expect(
    prepareShare("https://test/file", 2, "a.mp4", f),
  ).rejects.toThrow("DIRECT_SAVE_REQUIRED");
});
it("rejects expired or changed access identities", () => {
  const item = { hash: "a", size: 1 };
  expect(
    validOutputAccess(
      { url: "https://test/file", expiresAt: 100, hash: "a", size: 1 },
      item,
      50,
    ),
  ).toBe(true);
  expect(
    validOutputAccess(
      { url: "https://test/file", expiresAt: 100, hash: "a", size: 1 },
      item,
      100,
    ),
  ).toBe(false);
  expect(
    validOutputAccess(
      { url: "https://test/file", expiresAt: 100, hash: "b", size: 1 },
      item,
      50,
    ),
  ).toBe(false);
});
it("notifies only newest terminal attempts, with partial failures and stable fingerprint", () => {
  const jobs = [
    { id: "1", range_index: 0, attempt: 1, state: "failed" },
    { id: "2", range_index: 0, attempt: 2, state: "succeeded" },
    { id: "3", range_index: 1, attempt: 1, state: "failed" },
  ];
  expect(batchCompletion(jobs)?.kind).toBe("partial_failed");
  expect(batchCompletion([...jobs].reverse())).toEqual(batchCompletion(jobs));
  expect(
    batchCompletion([
      ...jobs,
      { id: "4", range_index: 1, attempt: 2, state: "held" },
    ]),
  ).toBe(null);
});
it("limits push transport origins and physically separates original deletion credentials", () => {
  expect(allowedPushEndpoint("https://web.push.apple.com/token")).toBe(true);
  for (const endpoint of [
    "https://evil.test/x",
    "https://web.push.apple.com.evil.test/x",
    "http://web.push.apple.com/x",
    "https://user@web.push.apple.com/x",
    "https://127.0.0.1/x",
  ])
    expect(allowedPushEndpoint(endpoint)).toBe(false);
  expect(() =>
    deletionStorage({
      VIDEO_DELETE_BUCKET: "originals",
      VIDEO_OUTPUT_BUCKET: "originals",
      CLOUD_R2_BUCKET: "originals",
    }),
  ).toThrow();
});

it("deletion adapter rejects original and staging keys before provider IO", async () => {
  const adapter = deletionStorage({
    VIDEO_DELETE_BUCKET: "outputs",
    VIDEO_OUTPUT_BUCKET: "outputs",
    CLOUD_R2_BUCKET: "originals",
    VIDEO_OUTPUT_ENDPOINT: "https://0000.r2.cloudflarestorage.com",
    VIDEO_DELETE_ACCESS_KEY_ID: "test-only",
    VIDEO_DELETE_SECRET_ACCESS_KEY: "test-only",
  });
  await expect(
    adapter.erase("originals/source", 1, "a".repeat(64)),
  ).rejects.toThrow("Original/staging deletion forbidden");
  await expect(
    adapter.erase("render-staging/temporary.mp4", 1, "a".repeat(64)),
  ).rejects.toThrow("Original/staging deletion forbidden");
});
