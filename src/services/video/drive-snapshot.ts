import type { LocalProjectData } from "./local-project";
import type { DriveUploadView } from "../../domain/drive-cloud/schema";
import { fnfSnapshotSchema } from "../../domain/video/schema";
import {
  allVersionsProjectSchema,
  newProject,
  projectIssues,
} from "../../domain/video/all-versions";
import {
  fnfShowcaseSnapshotSchema,
  fnfFilenames,
  FNF_FONT_HASH,
  FNF_RENDERER,
} from "../../domain/video/fnf-showcase";
/** Only immutable references and edit values cross this boundary: no Files, URLs, Canvas or functions. */
export function driveSnapshot(
  local: LocalProjectData,
  uploads: DriveUploadView[],
  cover?: DriveUploadView,
) {
  const clips = local.sources.map((source, i) => {
    const u = uploads[i];
    if (u?.state !== "ready" || !u.reference || !u.probe)
      throw Error("DRIVE_WORKER_NOT_READY");
    const duration = Number(u.probe.durationUs);
    if (!Number.isSafeInteger(duration) || duration <= 0)
      throw Error("DRIVE_WORKER_NOT_READY");
    return {
      id: source.id,
      source: u.reference,
      sourceDurationUs: duration,
      interval: {
        startUs: Math.round(source.start * 1e6),
        endUs: Math.round(source.end * 1e6),
      },
      markersUs: source.markers.trim()
        ? source.markers.split(",").map((v) => Math.round(Number(v) * 1e6))
        : [],
    };
  });
  const document = {
    schemaVersion: 1,
    kind: "all-versions",
    id: local.id,
    revision: 0,
    clips,
    fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
  };
  if (local.mode === "fnf-showcase") {
    const source = local.sources[0],
      probe = uploads[0].probe!;
    const width = Number(probe.displayWidth ?? probe.width),
      height = Number(probe.displayHeight ?? probe.height),
      crop = height - local.cropTop - local.cropBottom;
    const ranges = local.ranges
      .map((r, i) => ({ ...r, order: i }))
      .sort((a, b) => a.start - b.start || a.order - b.order);
    const snapshot = fnfShowcaseSnapshotSchema.parse({
      schemaVersion: 1,
      kind: "fnf-showcase-snapshot",
      id: local.id,
      document: {
        ...document,
        clips: [
          {
            ...clips[0],
            interval: { startUs: 0, endUs: clips[0].sourceDurationUs },
            markersUs: [],
          },
        ],
      },
      ranges: ranges.map((r) => ({
        startUs: Math.round(r.start * 1e6),
        endUs: Math.round(r.end * 1e6),
      })),
      chartNames: ranges.map((r) => r.name),
      names: fnfFilenames(ranges.map((r) => r.name)),
      creationOrders: ranges.map((r) => r.order),
      preferences: {
        schemaVersion: 1,
        username: local.username,
        template: {
          presetWidth: width,
          presetHeight: height,
          cropTop: local.cropTop,
          cropBottom: local.cropBottom,
          scale:
            Math.min(1080 / source.width, 1400 / crop) *
            Math.min(2, Math.max(0.1, local.scaleFactor)),
          rendererVersion: FNF_RENDERER,
          fontHash: FNF_FONT_HASH,
        },
      },
    });
    return { snapshot };
  }
  if (cover?.state !== "ready" || !cover.reference)
    throw Error("COVER_REQUIRED");
  const project = allVersionsProjectSchema.parse({
    ...newProject(),
    id: local.id,
    document,
    cover: cover.reference,
    namesText: local.names,
  });
  if (projectIssues(project).length) throw Error("PROJECT_INVALID");
  const duration = clips.reduce(
    (n, c) => n + c.interval.endUs - c.interval.startUs,
    0,
  );
  return {
    snapshot: fnfSnapshotSchema.parse({
      schemaVersion: 1,
      id: local.id,
      document,
      ranges: [{ startUs: 0, endUs: duration }],
      names: ["all-versions.mp4"],
    }),
    project,
  };
}
