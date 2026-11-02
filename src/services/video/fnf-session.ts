import { allVersionsDocumentSchema } from "../../domain/video/schema";
import {
  fnfShowcaseSnapshotSchema,
  fnfFilenames,
  type FnfPreferences,
} from "../../domain/video/fnf-showcase";
import type { MediaVersionRef } from "../../domain/cloud-library/schema";
import { toFrame } from "../../domain/video/time";
import { moveRange, validateRange } from "./time";
export type FnfRange = {
  id: string;
  creationOrder: number;
  startUs: number;
  endUs: number;
  name: string;
};
export type FnfSource = {
  reference: MediaVersionRef;
  durationUs: number;
  width: number;
  height: number;
  geometryVerified: boolean;
};
/** Pure memory session. No DB/localStorage/cloud-project dependency. */
export class FnfSession {
  ranges: FnfRange[] = [];
  private order = 0;
  constructor(readonly source: FnfSource) {
    if (source.reference.kind !== "video")
      throw new Error("FNF_SOURCE_MISSING");
    this.add(0, source.durationUs);
  }
  private add(startUs: number, endUs: number) {
    validateRange({ startUs, endUs }, this.source.durationUs);
    if (toFrame(endUs) <= toFrame(startUs))
      throw new Error("FNF_INVALID_RANGE");
    const r = {
      id: crypto.randomUUID(),
      creationOrder: this.order++,
      startUs,
      endUs,
      name: "",
    };
    this.ranges = [...this.ranges, r];
    return r;
  }
  addAt(currentUs: number) {
    return this.add(
      currentUs,
      Math.min(this.source.durationUs, currentUs + 30_000_000),
    );
  }
  edit(id: string, startUs: number, endUs: number) {
    validateRange({ startUs, endUs }, this.source.durationUs);
    if (toFrame(endUs) <= toFrame(startUs))
      throw new Error("FNF_INVALID_RANGE");
    this.ranges = this.ranges.map((r) =>
      r.id === id ? { ...r, startUs, endUs } : r,
    );
  }
  move(id: string, startUs: number) {
    const r = this.ranges.find((r) => r.id === id);
    if (!r) throw new Error("FNF_INVALID_RANGE");
    const next = moveRange(r, startUs - r.startUs, this.source.durationUs);
    this.edit(id, next.startUs, next.endUs);
  }
  name(id: string, name: string) {
    this.ranges = this.ranges.map((r) => (r.id === id ? { ...r, name } : r));
  }
  remove(id: string) {
    this.ranges = this.ranges.filter((r) => r.id !== id);
  }
  adopt(ranges: import("./time").PreviewRange[]) {
    const next = ranges.map((r) => {
      validateRange(r, this.source.durationUs);
      const old = this.ranges.find((v) => v.id === r.id);
      return { ...r, creationOrder: old?.creationOrder ?? this.order++ };
    });
    if (new Set(next.map((r) => r.id)).size !== next.length)
      throw new Error("FNF_INVALID_RANGE");
    this.ranges = next;
  }
  sorted() {
    return [...this.ranges].sort(
      (a, b) => a.startUs - b.startUs || a.creationOrder - b.creationOrder,
    );
  }
  document() {
    return allVersionsDocumentSchema.parse({
      schemaVersion: 1,
      kind: "all-versions",
      id: "fnf-session",
      revision: 0,
      fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
      clips: [
        {
          id: "source",
          source: this.source.reference,
          sourceDurationUs: this.source.durationUs,
          interval: { startUs: 0, endUs: this.source.durationUs },
          markersUs: [],
        },
      ],
    });
  }
  snapshot(preferences: FnfPreferences) {
    const ordered = this.sorted(),
      chartNames = ordered.map((r) => r.name);
    return fnfShowcaseSnapshotSchema.parse({
      schemaVersion: 1,
      kind: "fnf-showcase-snapshot",
      id: crypto.randomUUID(),
      document: this.document(),
      ranges: ordered.map((r) => ({ startUs: r.startUs, endUs: r.endUs })),
      creationOrders: ordered.map((r) => r.creationOrder),
      chartNames,
      names: fnfFilenames(chartNames),
      preferences,
    });
  }
}
