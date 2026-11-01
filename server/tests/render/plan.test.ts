import { it, expect } from "vitest";
import { renderPlan } from "../../worker/render/plan";
import {
  retryDelay,
  codeOf,
  RenderError,
  storageError,
} from "../../worker/jobs/errors";
import { renderConfiguration } from "../../worker/render/main";
import { localPath } from "../../worker/render/process";
import { colorFilter } from "../../worker/render/encode";
import type { FnfSnapshot } from "../../../src/domain/video/schema";
function snapshot(durations: number[]): FnfSnapshot {
  return {
    schemaVersion: 1,
    id: "snap",
    document: {
      schemaVersion: 1,
      kind: "all-versions",
      id: "doc",
      revision: 0,
      fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
      clips: durations.map((n, i) => ({
        id: `clip-${i}`,
        source: {
          libraryId: "cloud",
          fileId: `f${i}`,
          versionId: `v${i}`,
          hash: "a".repeat(64),
          kind: "video",
        },
        sourceDurationUs: n,
        interval: { startUs: 0, endUs: n },
        markersUs: [],
      })),
    },
    ranges: [{ startUs: 0, endUs: durations.reduce((a, b) => a + b, 0) }],
    names: ["out.mp4"],
  };
}
it("uses cumulative 60fps clip boundaries; 100-hour plans remain integer and seekable", () => {
  const p = renderPlan(snapshot([25001, 25001, 25001]), 0, "fnf", 2);
  expect(p.frames).toBe(5);
  expect(p.pieces.map((x) => x.frames)).toEqual([2, 1, 2]);
  expect(p.segments.map((x) => x.outputStartFrame)).toEqual([0, 2, 3]);
  const long = renderPlan(snapshot([360_000_000_000]), 0);
  expect(long.frames).toBe(21600000);
  expect(
    long.segments.at(-1)!.outputStartFrame + long.segments.at(-1)!.frames,
  ).toBe(long.frames);
});
it("cuts across a clip boundary on integer frames without per-clip rounding", () => {
  const s = snapshot([1_000_000, 1_000_000]);
  s.ranges = [{ startUs: 983333, endUs: 1033333 }];
  const p = renderPlan(s, 0);
  expect(p.frames).toBe(3);
  expect(p.pieces.map((x) => x.frames)).toEqual([1, 2]);
});
it("retries transient faults only, twice, at 30/120s plus bounded jitter", () => {
  expect(retryDelay("STORAGE_TRANSIENT", 1, () => 0)).toBe(30);
  expect(retryDelay("DATABASE_TRANSIENT", 2, () => 0.9999)).toBe(130);
  expect(retryDelay("PROCESS_TIMEOUT", 3)).toBeNull();
  for (const code of [
    "WORKER_LOST",
    "STORAGE_REJECTED",
    "DISK_FULL",
    "OUT_OF_MEMORY",
    "INPUT_CORRUPT",
    "QUOTA_EXCEEDED",
    "VALIDATION_FAILED",
  ] as const)
    expect(retryDelay(code, 1)).toBeNull();
  expect(codeOf({ code: "ENOSPC" })).toBe("DISK_FULL");
  expect(codeOf(new RenderError("OUT_OF_MEMORY"))).toBe("OUT_OF_MEMORY");
});
it("fails closed on resources and rejects arbitrary media URLs", () => {
  expect(() =>
    renderConfiguration({ VIDEO_DATABASE_URL: "postgres://localhost/video" }),
  ).toThrow();
  for (const p of ["https://evil.test/a", "file:/etc/passwd", "concat:a|b"])
    expect(() => localPath(p)).toThrow();
  const track = {
    codec_type: "video",
    codec_name: "hevc",
    time_base: "1/60000",
    color_transfer: "smpte2084",
    color_primaries: "bt2020",
    color_space: "bt2020nc",
  };
  expect(colorFilter(track)).toContain("tonemap");
  expect(colorFilter({ ...track, color_transfer: "arib-std-b67" })).toContain(
    "t=linear",
  );
  expect(() => colorFilter({ ...track, color_space: undefined })).toThrow();
});

it("does not classify permanent or unknown provider failures as transient", () => {
  expect(storageError({ $metadata: { httpStatusCode: 503 } }).code).toBe(
    "STORAGE_TRANSIENT",
  );
  expect(storageError({ code: "ETIMEDOUT" }).code).toBe("STORAGE_TRANSIENT");
  expect(storageError({ $metadata: { httpStatusCode: 403 } }).code).toBe(
    "STORAGE_REJECTED",
  );
  expect(storageError(new Error("private details")).code).toBe(
    "STORAGE_REJECTED",
  );
  expect(storageError({ code: "ENOSPC" }).code).toBe("DISK_FULL");
});
