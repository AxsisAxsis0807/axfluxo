import { createRoot } from "react-dom/client";
import LocalVideoTool from "../../../src/features/developer/LocalVideoTool";
import ExportDock from "../../../src/features/video-common/ExportDock";
import {
  LOCK_KEY,
  SESSION_KEY,
  UNLOCK_MS,
} from "../../../src/services/developer/local-lock";
import {
  localExportQueue,
  flushExportRecovery,
} from "../../../src/services/video/local-export-runtime";
import { renewRecoveryLease, saveExportEntries, saveLocalProject } from "../../../src/services/video/recovery-store";
import type { LocalProjectData } from "../../../src/services/video/local-project";

async function seedLegacyData(finished: boolean) {
  const file = document.querySelector<HTMLInputElement>('input[aria-label="端末の素材"]')?.files?.[0];
  if (!file) throw Error("Legacy fixture needs its source file.");
  const project: LocalProjectData = {
    id: "legacy-fixture", mode: "fnf-showcase", cover: "", coverId: "", names: "",
    sources: [{ id: "source", file, url: "", duration: 4, width: 160, height: 90,
      start: 0, end: 4, markers: "" }],
    ranges: [{ id: "range", name: "LEGACY", start: 0, end: 2 }],
    username: "@username", cropTop: 0, cropBottom: 0, scaleFactor: 1,
  };
  await saveLocalProject(project);
  if (finished)
    await saveExportEntries([{
      id: "legacy-output", filename: "LEGACY.mp4", state: "completed",
      progress: 1, message: "完了・保存できます", rest: true,
      recovery: { project, index: 0 }, result: { blob: file, filename: "LEGACY.mp4" },
    }]);
}

localStorage.setItem(
  LOCK_KEY,
  JSON.stringify({ salt: "a".repeat(32), hash: "b".repeat(64) }),
);
sessionStorage.setItem(SESSION_KEY, String(Date.now() + UNLOCK_MS));
Object.assign(window, { localExportQueue, flushExportRecovery, seedLegacyData, renewRecoveryLease });
createRoot(document.getElementById("root")!).render(
  <>
    <LocalVideoTool
      mode={location.pathname.includes("all") ? "all-versions" : "fnf-showcase"}
      ownerId="device-local"
    />
    <ExportDock />
  </>,
);
