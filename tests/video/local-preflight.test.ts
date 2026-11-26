import { afterEach, expect, it, vi } from "vitest";
import {
  ALL_VERSIONS_FILE_GAP_SECONDS,
  localIntervals,
  localProjectIssue,
  type LocalProjectData,
} from "../../src/services/video/local-project";
import { recorderType } from "../../src/services/video/local-encode";
const p = (): LocalProjectData => ({
  id: "p",
  mode: "all-versions",
  names: "A\nB",
  ranges: [],
  username: "@test",
  scaleFactor: 1,
  cropTop: 0,
  cropBottom: 0,
  cover: "blob:cover",
  coverId: "cover",
  sources: [
    {
      id: "s",
      file: new File(["input"], "a.wav"),
      url: "blob:input",
      start: 0,
      end: 10,
      duration: 10,
      width: 0,
      height: 0,
      markers: "",
    },
  ],
});
afterEach(() => vi.unstubAllGlobals());
it("explains that multiple Version names require boundaries without throwing during rendering", () => {
  const project = p();
  expect(localProjectIssue(project)).toContain("Version境界");
  project.sources[0].markers = "5";
  expect(localProjectIssue(project)).toBe("");
  project.cover = "";
  expect(localProjectIssue(project)).toContain("カバー画像");
  project.sources[0].markers = "5,5";
  expect(() => localProjectIssue(project)).not.toThrow();
  expect(localProjectIssue(project)).toContain("昇順");
});
it("rejects incomplete numeric values and invalid range settings", () => {
  const project = p();
  project.sources[0].end = NaN;
  expect(localProjectIssue(project)).toContain("開始・終了");
  project.mode = "fnf-showcase";
  project.sources[0].height = 100;
  project.scaleFactor = NaN;
  expect(localProjectIssue(project)).toContain("映像スケール");
});
it("detects MIME support through the actual API and never calls WebM MP4", () => {
  vi.stubGlobal("MediaRecorder", undefined);
  expect(recorderType()).toBeNull();
  vi.stubGlobal("MediaRecorder", {
    isTypeSupported: (type: string) => type.startsWith("video/webm"),
  });
  expect(recorderType()).toBe("video/webm;codecs=vp8,opus");
  vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
  expect(recorderType()).toBeNull();
});

it("adds fixed gaps only between trimmed source files, not internal version boundaries", () => {
  const first = { start: 1, end: 5, duration: 6, markers: "3" };
  const second = { start: 2, end: 5, duration: 7, markers: "" };
  const third = { start: 0, end: 2, duration: 2, markers: "" };
  const fourth = { start: 1, end: 3, duration: 3, markers: "" };
  const gap = ALL_VERSIONS_FILE_GAP_SECONDS;
  expect(gap).toBe(1.5);
  expect(localIntervals([first], gap)).toEqual([
    { start: 0, end: 2 }, { start: 2, end: 4 },
  ]);
  expect(localIntervals([first, second, third, fourth], gap)).toEqual([
    { start: 0, end: 2 }, { start: 2, end: 4 },
    { start: 5.5, end: 8.5 }, { start: 10, end: 12 },
    { start: 13.5, end: 15.5 },
  ]);
  expect(localIntervals([second, first], gap)).toEqual([
    { start: 0, end: 3 }, { start: 4.5, end: 6.5 },
    { start: 6.5, end: 8.5 },
  ]);
  expect(localIntervals([first, second]).at(-1)?.end).toBe(7);
});
