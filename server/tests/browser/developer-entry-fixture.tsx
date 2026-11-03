import React from "react";
import { createRoot } from "react-dom/client";
import {
  DeveloperGate,
  DeveloperStudioEntry,
} from "../../../src/features/developer/DeveloperAccess";
import OutputLibrary from "../../../src/features/developer/OutputLibrary";
import AllVersionsEditor from "../../../src/features/all-versions/AllVersionsEditor";
import FnfShowcaseEditor from "../../../src/features/fnf-showcase/FnfShowcaseEditor";
const path = location.pathname;
createRoot(document.getElementById("root")!).render(
  path.includes("/developer/") ? (
    <DeveloperGate>
      {(api) =>
        path.includes("all-versions") ? (
          <AllVersionsEditor api={api} />
        ) : path.includes("fnf-showcase") ? (
          <FnfShowcaseEditor api={api} />
        ) : (
          <OutputLibrary api={api} />
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
