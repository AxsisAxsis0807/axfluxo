import { describe, expect, it } from "vitest";
import {
  ALL_VERSIONS_FILE_GAP_SECONDS,
  localIntervals,
} from "../src/services/video/local-project";

const source = (
  duration: number,
  markers = "",
  start = 0,
  end = duration,
) => ({ duration, start, end, markers });

describe("All Versions fixed inter-file silence", () => {
  it("adds no silence for a single file, even with internal version boundaries", () => {
    expect(localIntervals([source(10, "4,7")])).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 7 },
      { start: 7, end: 10 },
    ]);
  });

  it("adds exactly 1.5 seconds between distinct files but never between markers", () => {
    expect(ALL_VERSIONS_FILE_GAP_SECONDS).toBe(1.5);
    expect(localIntervals([source(10, "4"), source(8, "3")])).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 10 },
      { start: 11.5, end: 14.5 },
      { start: 14.5, end: 19.5 },
    ]);
  });

  it("handles three files and trimmed source ranges without including trim in gaps", () => {
    expect(
      localIntervals([
        source(20, "", 5, 9),
        source(20, "6", 2, 10),
        source(12, "", 2, 5),
      ]),
    ).toEqual([
      { start: 0, end: 4 },
      { start: 5.5, end: 9.5 },
      { start: 9.5, end: 13.5 },
      { start: 15, end: 18 },
    ]);
  });
});
