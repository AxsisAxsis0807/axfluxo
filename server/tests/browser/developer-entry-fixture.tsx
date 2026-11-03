import React from "react";
import { createRoot } from "react-dom/client";
import {
  DeveloperGate,
  DeveloperStudioEntry,
} from "../../../src/features/developer/DeveloperAccess";
import Studio from "../../../src/features/developer/DeveloperStudio";
import Tool from "../../../src/features/developer/DeveloperTool";
const path = location.pathname;
createRoot(document.getElementById("root")!).render(
  path.includes("/developer/") ? (
    <DeveloperGate>
      {(access) =>
        path.includes("all-versions") ? (
          <Tool mode="all-versions" ownerId={access.ownerId} />
        ) : path.includes("fnf-showcase") ? (
          <Tool mode="fnf-showcase" ownerId={access.ownerId} />
        ) : (
          <Studio />
        )
      }
    </DeveloperGate>
  ) : (
    <aside>
      <span>アカウント</span>
      <DeveloperStudioEntry />
    </aside>
  ),
);
