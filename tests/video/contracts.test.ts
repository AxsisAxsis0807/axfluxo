import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  allVersionsDocumentSchema,
  fnfSnapshotSchema,
  renderJobSchema,
  saveConfirmationSchema,
  toPersistentDocument,
} from "../../src/domain/video/schema";
import {
  filenameSchema,
  mediaVersionRefSchema,
} from "../../src/domain/cloud-library/schema";
import { concatenateFrames, toFrame } from "../../src/domain/video/time";
import {
  DEVELOPER_STORES,
  openDeveloperDB,
} from "../../src/services/developer/db";
import { addOriginalVersion } from "../../src/services/developer/originals";
const ref = {
  libraryId: "local",
  fileId: "media",
  versionId: "v1",
  hash: "a".repeat(64),
  kind: "video" as const,
};
const document = () => ({
  schemaVersion: 1 as const,
  kind: "all-versions" as const,
  id: "doc",
  revision: 0,
  clips: [
    {
      id: "c1",
      source: ref,
      sourceDurationUs: 1_000_000,
      interval: { startUs: 0, endUs: 1_000_000 },
      markersUs: [500_000],
    },
  ],
  fnf: { schemaVersion: 1 as const, mode: "fnf" as const, paddingUs: 0 },
});
const snapshot = () => ({
  schemaVersion: 1,
  id: "snap",
  document: document(),
  ranges: [{ startUs: 0, endUs: 1_000_000 }],
  names: ["chart.mp4"],
});
describe("video V0 isolated contracts", () => {
  it("converts long times exactly without multiplication precision loss", () => {
    for (const us of [0, 8_333, 8_334, 86_400_000_001, Number.MAX_SAFE_INTEGER])
      expect(toFrame(us)).toBe(
        Number((BigInt(us) * 60n + 500_000n) / 1_000_000n),
      );
    for (const bad of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => toFrame(bad)).toThrow();
  });
  it("rounds cumulative joins and rejects zero frames and overflow", () => {
    const frames = concatenateFrames(Array(100).fill(20_000));
    expect(frames.at(-1)?.endFrame).toBe(120);
    expect(
      frames.every(
        (v, i) => i === 0 || v.startFrame === frames[i - 1].endFrame,
      ),
    ).toBe(true);
    expect(() => concatenateFrames([1])).toThrow("VIDEO_ZERO_FRAMES");
    expect(() => concatenateFrames([Number.MAX_SAFE_INTEGER, 20_000])).toThrow(
      "VIDEO_TIME_OVERFLOW",
    );
  });
  it("validates ordered internal markers, unique clips and source bounds", () => {
    expect(allVersionsDocumentSchema.safeParse(document()).success).toBe(true);
    for (const markersUs of [
      [0],
      [1_000_000],
      [500_000, 500_000],
      [600_000, 400_000],
    ]) {
      const d = document();
      d.clips[0].markersUs = markersUs;
      expect(allVersionsDocumentSchema.safeParse(d).success).toBe(false);
    }
    const d = document();
    d.clips.push(d.clips[0]);
    expect(allVersionsDocumentSchema.safeParse(d).success).toBe(false);
    for (const endUs of [0, 1, 1_000_001]) {
      const d = document();
      d.clips[0].interval.endUs = endUs;
      expect(allVersionsDocumentSchema.safeParse(d).success).toBe(false);
    }
  });
  it("rejects overlap, unordered/outside/zero-frame ranges and name count", () => {
    expect(fnfSnapshotSchema.safeParse(snapshot()).success).toBe(true);
    for (const ranges of [
      [
        { startUs: 0, endUs: 700_000 },
        { startUs: 600_000, endUs: 900_000 },
      ],
      [{ startUs: 0, endUs: 1_000_001 }],
      [{ startUs: 0, endUs: 1 }],
    ])
      expect(
        fnfSnapshotSchema.safeParse({
          ...snapshot(),
          ranges,
          names: ranges.map((_, i) => `chart${i}.mp4`),
        }).success,
      ).toBe(false);
    expect(
      fnfSnapshotSchema.safeParse({ ...snapshot(), names: [] }).success,
    ).toBe(false);
    expect(
      fnfSnapshotSchema.safeParse({
        ...snapshot(),
        ranges: [
          { startUs: 0, endUs: 500_000 },
          { startUs: 500_000, endUs: 1_000_000 },
        ],
        names: ["a.mp4", "A.mp4"],
      }).success,
    ).toBe(false);
  });
  it.each([
    "../a.mp4",
    "a/b",
    "a\\b",
    "CON.mp4",
    "a\u0000.mp4",
    "a.",
    "a ",
    "a:b",
    "..",
  ])("rejects dangerous filename %s", (name) =>
    expect(filenameSchema.safeParse(name).success).toBe(false),
  );
  it("rejects unknown versions/latest refs and excludes unsent FNF fields", () => {
    expect(
      allVersionsDocumentSchema.safeParse({ ...document(), schemaVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      mediaVersionRefSchema.safeParse({
        ...ref,
        versionId: undefined,
        latest: true,
      }).success,
    ).toBe(false);
    const form = {
      ...document(),
      ranges: [{ startUs: 0, endUs: 10 }],
      names: ["private"],
      fnf: { ...document().fnf, names: ["private"] },
    };
    expect(allVersionsDocumentSchema.safeParse(form).success).toBe(false);
    expect(toPersistentDocument(form)).toEqual(document());
    expect(JSON.stringify(toPersistentDocument(form))).not.toContain("private");
  });
  it("does not claim incomplete outputs or OS downloads as saved", () => {
    expect(
      renderJobSchema.safeParse({
        schemaVersion: 1,
        id: "job",
        snapshot: snapshot(),
        state: "succeeded",
        outputs: [],
      }).success,
    ).toBe(false);
    expect(
      saveConfirmationSchema.safeParse({ state: "confirmed", outputId: "out" })
        .success,
    ).toBe(false);
  });
  it("checks successful output identity, filename and exact frame count", () => {
    const output = {
      schemaVersion: 1,
      id: "out",
      jobId: "job",
      reference: ref,
      filename: "chart.mp4",
      fps: 60,
      frameCount: 60,
    };
    const job = {
      schemaVersion: 1,
      id: "job",
      snapshot: snapshot(),
      state: "succeeded",
      outputs: [output],
    };
    expect(renderJobSchema.safeParse(job).success).toBe(true);
    for (const change of [
      { frameCount: 59 },
      { filename: "wrong.mp4" },
      { jobId: "other" },
      { reference: { ...ref, kind: "audio" } },
    ])
      expect(
        renderJobSchema.safeParse({
          ...job,
          outputs: [{ ...output, ...change }],
        }).success,
      ).toBe(false);
    expect(
      saveConfirmationSchema.safeParse({
        schemaVersion: 1,
        state: "confirmed",
        outputId: "out",
        reference: ref,
        receiptId: "receipt",
      }).success,
    ).toBe(true);
  });
  it("creates only developer v1 stores and rejects original replacement", async () => {
    const db = await openDeveloperDB();
    expect(db.name).toBe("axfluxo-developer");
    expect(db.version).toBe(1);
    expect(Array.from(db.objectStoreNames).sort()).toEqual(
      [...DEVELOPER_STORES].sort(),
    );
    db.close();
    const original = {
      schemaVersion: 1,
      reference: ref,
      filename: "source.mp4",
      originalHash: ref.hash,
      byteLength: 100,
      mime: "video/mp4",
    };
    await addOriginalVersion(original);
    await expect(
      addOriginalVersion({ ...original, originalHash: "b".repeat(64) }),
    ).rejects.toThrow("VIDEO_IMMUTABLE_VERSION");
    const check = await openDeveloperDB();
    const stored = await new Promise<{ value: { originalHash: string } }>(
      (resolve, reject) => {
        const request = check
          .transaction("originalVersions")
          .objectStore("originalVersions")
          .get(JSON.stringify([ref.libraryId, ref.fileId, ref.versionId]));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    check.close();
    expect(stored.value.originalHash).toBe(ref.hash);
    expect((await indexedDB.databases()).map((d) => d.name)).toEqual([
      "axfluxo-developer",
    ]);
  });
});
