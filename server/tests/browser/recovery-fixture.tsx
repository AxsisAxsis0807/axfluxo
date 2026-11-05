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
localStorage.setItem(
  LOCK_KEY,
  JSON.stringify({ salt: "a".repeat(32), hash: "b".repeat(64) }),
);
sessionStorage.setItem(SESSION_KEY, String(Date.now() + UNLOCK_MS));
Object.assign(window, { localExportQueue, flushExportRecovery });
createRoot(document.getElementById("root")!).render(
  <>
    <LocalVideoTool
      mode={location.pathname.includes("all") ? "all-versions" : "fnf-showcase"}
      ownerId="device-local"
    />
    <ExportDock />
  </>,
);
