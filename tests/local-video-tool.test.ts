import { expect, it } from "vitest";
import { localIntervals } from "../src/features/developer/LocalVideoTool";
it("retains clip order and maps source markers onto the combined timeline", () => {
  expect(
    localIntervals([
      { start: 10, end: 14, duration: 20, markers: "11, 13" },
      { start: 2, end: 5, duration: 10, markers: "" },
    ]),
  ).toEqual([
    { start: 0, end: 1 },
    { start: 1, end: 3 },
    { start: 3, end: 4 },
    { start: 4, end: 7 },
  ]);
});
it("rejects out-of-source trims and unsorted, duplicate or invalid markers", () => {
  for (const source of [
    { start: 0, end: 11, duration: 10, markers: "" },
    { start: 0, end: 10, duration: 10, markers: "6,5" },
    { start: 0, end: 10, duration: 10, markers: "5,5" },
    { start: 0, end: 10, duration: 10, markers: "NaN" },
    { start: -1, end: 1, duration: 10, markers: "" },
  ])
    expect(() => localIntervals([source])).toThrow();
});
