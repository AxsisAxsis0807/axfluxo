import { it, expect } from "vitest";
import {
  frameTimeUs,
  formatTime,
  parseTime,
  stepTime,
  moveRange,
  clipAt,
  validateRange,
} from "../../../src/services/video/time";
import { PlaybackController } from "../../../src/services/video/playback";
import {
  saveVideoDocument,
  loadVideoDocument,
} from "../../../src/services/video/document";
import "fake-indexeddb/auto";
it("round-trips long integer microseconds without Date/timezone limits", () => {
  for (const us of [0, 1, 3599999999, 360000000000, Number.MAX_SAFE_INTEGER])
    expect(parseTime(formatTime(us))).toBe(us);
  for (const text of ["NaN", "-1", "00:60:00", "0.1234567", "1e9"])
    expect(() => parseTime(text)).toThrow();
});
it.each([
  { numerator: 30000, denominator: 1001 },
  { numerator: 30, denominator: 1 },
  { numerator: 60000, denominator: 1001 },
  { numerator: 60, denominator: 1 },
])(
  "keeps exact rational frame boundaries for $numerator/$denominator",
  (rate) => {
    for (const frame of [0, 1, 60000, 10000000]) {
      const n = BigInt(frame) * 1000000n * BigInt(rate.denominator),
        d = BigInt(rate.numerator);
      expect(frameTimeUs(frame, rate)).toBe(Number((n + d / 2n) / d));
    }
  },
);
it("steps output frames without cumulative clip rounding and allows independent overlapping FNF ranges", () => {
  let us = 0;
  for (let i = 0; i < 600; i++) us = stepTime(us, 1);
  expect(us).toBe(10000000);
  const r = { id: "r", startUs: 2000000, endUs: 5000000, name: "unsent" };
  expect(moveRange(r, -4000000, 10000000)).toMatchObject({
    startUs: 0,
    endUs: 3000000,
  });
  expect(() => validateRange({ startUs: 0, endUs: 1 }, 1000)).toThrow();
  validateRange({ startUs: 1_000_000, endUs: 4_000_000 }, 10_000_000);
  validateRange({ startUs: 2_000_000, endUs: 3_000_000 }, 10_000_000);
  expect(
    clipAt(
      [
        { id: "a", interval: { startUs: 9000, endUs: 19000 } },
        { id: "b", interval: { startUs: 30000, endUs: 50000 } },
      ],
      10000,
    ),
  ).toMatchObject({ index: 1, sourceUs: 30000 });
});
it("renews signed access once, preserves position and uses media time as the clock", async () => {
  let calls = 0;
  const media = {
    currentTime: 360000,
    readyState: 1,
    playsInline: false,
    preload: "",
    src: "old",
    pause: () => {},
    play: async () => {},
    load: () => {},
    removeAttribute: () => {},
  } as unknown as HTMLVideoElement;
  const mapping = {
    sourceFirstPtsUs: 500000,
    proxyFirstPtsUs: 0,
    sourceTimeBase: "1/90000",
    proxyTimeBase: "1/1000000",
  };
  const controller = new PlaybackController(
    media,
    async () => {
      calls++;
      return { url: "https://private.test/new", mapping };
    },
    mapping,
  );
  expect(controller.currentUs()).toBe(360000000000);
  await Promise.all([controller.refreshAccess(), controller.refreshAccess()]);
  expect(calls).toBe(1);
  media.currentTime = 0;
  controller.loaded();
  expect(media.currentTime).toBe(360000);
  controller.seek(frameTimeUs(1));
  expect(media.currentTime).toBe(0.016667);
});
it("persists only All Versions edits with CAS; transient FNF ranges/names do not enter the document", async () => {
  const doc = {
    schemaVersion: 1 as const,
    kind: "all-versions" as const,
    id: "preview-doc",
    revision: 0,
    clips: [
      {
        id: "clip",
        source: {
          libraryId: "cloud",
          fileId: "f",
          versionId: "v",
          hash: "a".repeat(64),
          kind: "video" as const,
        },
        sourceDurationUs: 1000000,
        interval: { startUs: 100000, endUs: 900000 },
        markersUs: [500000],
      },
    ],
    fnf: { schemaVersion: 1 as const, mode: "fnf" as const, paddingUs: 0 },
  };
  const form = {
    ...doc,
    ranges: [{ startUs: 0, endUs: 1 }],
    names: ["private-unsent"],
  };
  const saved = await saveVideoDocument(form);
  expect(saved.revision).toBe(1);
  expect(await loadVideoDocument(doc.id)).toEqual(saved);
  expect(JSON.stringify(saved)).not.toMatch(/private-unsent|ranges|names/);
  await expect(saveVideoDocument(doc)).rejects.toThrow("VIDEO_CONFLICT");
});
