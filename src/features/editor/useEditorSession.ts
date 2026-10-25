"use client";
import { useReducer, useState } from "react";
import { reducer, type ProjectDocument } from "../../domain/document";

/** One editing history and UI state per mounted editor. Persistence is owned by
 * the caller, so a render component unmount cannot dispose a save coordinator.
 * Undo history is session-local; this hook does not claim to persist it. */
export function useEditorSession(initialDocument: ProjectDocument) {
  const [history, dispatch] = useReducer(reducer, {
    past: [],
    present: initialDocument,
    future: [],
  });
  const doc = history.present;
  const [pageId, setPageId] = useState(doc.pages[0].id);
  const [selected, setSelected] = useState<string>();
  const [panel, setPanel] = useState<"design" | "layers" | "variables">(
    "design",
  );
  const [mobilePanel, setMobilePanel] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const [panMode, setPanMode] = useState(false);
  const [fitToken, setFitToken] = useState(0);
  return {
    history,
    dispatch,
    doc,
    pageId,
    setPageId,
    selected,
    setSelected,
    panel,
    setPanel,
    mobilePanel,
    setMobilePanel,
    zoom,
    setZoom,
    snap,
    setSnap,
    panMode,
    setPanMode,
    fitToken,
    setFitToken,
  };
}
