import { describe, expect, it } from "vitest";
import type { Source } from "../../src/services/video/local-project";
import {
  exportNames,
  reorderAudio,
  updateAudio,
  versionRows,
  withAudioOrder,
} from "../../src/features/developer/all-versions-edit";

function source(id: string, markers = ""): Source {
  return {
    id,
    file: new File([""], `${id}.mp3`),
    url: `blob:${id}`,
    duration: 10,
    start: 1,
    end: 9,
    markers,
    width: 0,
    height: 0,
    timeline: {
      currentUs: 2e6,
      zoom: 40,
      gain: 1,
      editing: false,
      selected: id,
    },
  };
}

describe("All Versions audio editing", () => {
  it("moves complete sources and their legacy version rows together", () => {
    const a = source("a", "4");
    const b = source("b");
    const original = {
      sources: [a, b],
      names: " First \nSecond\nThird\nExtra",
    };
    const moved = reorderAudio(original, "b", -1);
    expect(moved.sources[0]).toBe(b);
    expect(moved.sources[1]).toBe(a);
    expect(moved.names).toBe("Third\n First \nSecond\nExtra");
    expect(reorderAudio(moved, "b", -1)).toBe(moved);
    expect(reorderAudio(moved, "b", 1)).toEqual(original);
  });

  it("keeps a later label attached when an unnamed source moves ahead of it", () => {
    const a = source("a");
    const b = source("b");
    const c = source("c");
    const moved = reorderAudio(
      { sources: [a, b, c], names: "First\nSecond" },
      "c",
      -1,
    );
    expect(moved.names).toBe("First\n\nSecond");
    expect(versionRows(moved).byId.get("b")).toEqual(["Second"]);
    const removed = withAudioOrder(moved, [a, b]);
    expect(removed.names).toBe("First\nSecond");
    expect(
      withAudioOrder({ ...removed, names: "A\nB\nC\nExtra" }, [a, b, c]).names,
    ).toBe("A\nB\nC\nExtra");
  });

  it("keeps labels on other sources when the number of segment boundaries changes", () => {
    const edit = { sources: [source("a"), source("b")], names: "A\nB" };
    const changed = updateAudio(edit, "a", { markers: "4" });
    expect(changed.names).toBe("A\n\nB");
    expect(versionRows(changed).byId.get("b")).toEqual(["B"]);
    const reduced = updateAudio({ ...changed, names: "A\nA2\nB" }, "a", {
      markers: "",
    });
    expect(versionRows(reduced).unassigned).toEqual(["A2"]);
  });

  it("joins song and version names with a space and preserves entered hyphens", () => {
    expect(exportNames("", "  NAME - UNKNOWN\r\nB ")).toBe(
      "  NAME - UNKNOWN\r\nB ",
    );
    expect(exportNames("KALYPSO", " (NORMAL) \n\n(Super-Slowed)")).toBe(
      "KALYPSO (NORMAL)\n\nKALYPSO (Super-Slowed)",
    );
  });
});
