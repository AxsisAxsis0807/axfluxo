"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { WORKFLOW_FIRST_ENABLED } from "../../config/workflow-limits";
const LegacyEditor = dynamic(() => import("../editor/Editor"), {
  ssr: false,
  loading: () => <p role="status">Studioを準備しています…</p>,
});
const WorkflowWorkspace = dynamic(() => import("./WorkflowWorkspace"), {
  ssr: false,
  loading: () => <p role="status">Workflowを準備しています…</p>,
});
export default function WorkspaceShell() {
  const [legacy, setLegacy] = useState(() => {
    try {
      return sessionStorage.getItem("axfluxo-view") === "legacy";
    } catch {
      return false;
    }
  });
  const [opened, setOpened] = useState(false);
  const [workflowOpened, setWorkflowOpened] = useState(!legacy);
  const chooseLegacy = () => {
    try {
      sessionStorage.setItem("axfluxo-view", "legacy");
    } catch {}
    setOpened(true);
    setLegacy(true);
  };
  const chooseWorkflow = () => {
    try {
      sessionStorage.removeItem("axfluxo-view");
    } catch {}
    setWorkflowOpened(true);
    setLegacy(false);
  };
  if (!WORKFLOW_FIRST_ENABLED) return <LegacyEditor />;
  return (
    <>
      <div hidden={legacy} inert={legacy ? true : undefined}>
        {workflowOpened && (
          <WorkflowWorkspace active={!legacy} onLegacy={chooseLegacy} />
        )}
      </div>
      {legacy && (
        <div className="legacy-workspace">
          <LegacyEditor onWorkflowFirst={chooseWorkflow} />
        </div>
      )}
      {opened && !legacy && (
        <span className="sr-only">
          旧Studioの作品はこの端末に保持されています
        </span>
      )}
    </>
  );
}
