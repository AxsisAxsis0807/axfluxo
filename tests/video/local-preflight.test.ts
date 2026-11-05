import { afterEach, expect, it, vi } from "vitest";
import {
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
