import React from "react";
import { createRoot } from "react-dom/client";
import { DeveloperStudioEntry } from "../../../src/features/developer/DeveloperAccess";
import LocalDeveloperGate from "../../../src/features/developer/LocalDeveloperGate";
import Studio from "../../../src/features/developer/DeveloperStudio";
import Tool from "../../../src/features/developer/DeveloperTool";
import ExportDock from "../../../src/features/video-common/ExportDock";
const path = location.pathname;
createRoot(document.getElementById("root")!).render(
  <>
    {path.includes("/developer/") ? (
      <LocalDeveloperGate>
        {path.includes("all-versions") ? (
          <Tool mode="all-versions" ownerId="device-local" />
        ) : path.includes("fnf-showcase") ? (
          <Tool mode="fnf-showcase" ownerId="device-local" />
        ) : (
          <Studio />
        )}
      </LocalDeveloperGate>
    ) : (
      <aside>
        <span>アカウント</span>
        <DeveloperStudioEntry />
      </aside>
    )}
    <ExportDock />
  </>,
);
