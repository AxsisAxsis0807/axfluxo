"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import WorkflowCanvas, { type FlowNode } from "../workflow/WorkflowCanvas";
import NodePalette from "../workflow/NodePalette";
import NodeInspector, { ConfigField } from "../workflow/NodeInspector";
import ImageEditSession from "../workflow/ImageEditSession";
import {
  newNode,
  type NodeType,
  type Viewport,
  type WorkflowNode,
} from "../../domain/workflow/schema";
import { arrange } from "../../domain/workflow/commands";
import { connectionError } from "../../domain/workflow/connections";
import {
  parseWorkspace,
  workspaceDefinitions,
  type WorkspaceDocument,
  type WorkspaceNode,
  type ImageEditNode,
  type EditorRecord,
  type AssetRef,
} from "../../domain/workspace/schema";
import { Autosave, type Status } from "../../services/workspace/autosave";
import { read } from "../../services/workspace/db";
import {
  applyEditor,
  currentOutput,
  duplicateEditor,
  listWorkspaces,
  loadEditor,
  loadWorkspace,
  loadRevision,
  newImageEdit,
  newWorkspace,
  saveWorkspace,
  saveDraft,
  storeAsset,
  now,
  type Bundle,
  type Artifact,
  type WorkspaceAsset,
} from "../../services/workspace/repository";
import {
  importLegacyWorkflow,
  legacyProjects,
  legacyWorkflows,
  migrationState,
  prepareLegacyProject,
} from "../../services/workspace/migration";
import {
  initializeInput,
  inputChanged,
  replaceInput,
  resolveInput,
} from "../../services/workspace/input";
import {
  renderImageEdit,
  imageEditRenderKey,
} from "../../services/editor/render-image-edit";
import {
  backupWorkspace,
  restoreWorkspace,
} from "../../services/workspace/backup";
import { download } from "../../services/backup";
import { importImage } from "../../services/assets";
import type { ProjectDocument } from "../../domain/document";
import WorkspaceDialog from "./WorkspaceDialog";
import Account from "../auth/Account";
import "../workflow/workflow.css";
import "./workspace.css";
type History = {
  past: WorkspaceDocument[];
  present: WorkspaceDocument;
  future: WorkspaceDocument[];
};
const defaultViewport = { x: 0, y: 0, zoom: 1 };
type Snapshot = { document: WorkspaceDocument; viewport: Viewport };
export default function WorkflowWorkspace({
  onLegacy,
  active = true,
}: {
  onLegacy: () => void;
  active?: boolean;
}) {
  const [history, setHistory] = useState<History>(),
    [viewport, setViewport] = useState<Viewport>(defaultViewport),
    [status, setStatus] = useState<Status>("保存済み"),
    [error, setError] = useState("");
  const [list, setList] = useState<WorkspaceDocument[]>([]),
    [selected, setSelected] = useState<string>(),
    [inspector, setInspector] = useState<string>();
  const [pending, setPending] = useState<{ nodeId: string; portId: string }>(),
    [pendingConfig, setPendingConfig] = useState(false),
    [operation, setOperation] = useState(false);
  const [session, setSession] = useState<{
      node: ImageEditNode;
      editor: EditorRecord;
      generation: number;
    }>(),
    [inputChoice, setInputChoice] = useState<{
      node: ImageEditNode;
      editor: EditorRecord;
      ref: AssetRef | null;
      unavailable?: string;
    }>();
  const [oldWorkflows, setOldWorkflows] = useState<
      Awaited<ReturnType<typeof legacyWorkflows>>
    >([]),
    [oldProjects, setOldProjects] = useState<ProjectDocument[]>([]),
    [importOpen, setImportOpen] = useState(false),
    [migrationLabels, setMigrationLabels] = useState<Record<string, string>>(
      {},
    );
  const [recoveries, setRecoveries] = useState<WorkspaceDocument[]>([]);
  const [assetList, setAssetList] = useState<WorkspaceAsset[]>([]),
    [outputs, setOutputs] = useState<Record<string, Artifact>>({}),
    [thumbnails, setThumbnails] = useState<Record<string, string>>({}),
    [generating, setGenerating] = useState<string>(),
    [renderError, setRenderError] = useState("");
  const [inputStatus, setInputStatus] = useState("");
  const saver = useRef<Autosave<Snapshot, WorkspaceDocument> | null>(null),
    current = useRef<{ history?: History; viewport: Viewport }>({
      viewport: defaultViewport,
    });
  const flow = useRef<ReactFlowInstance<FlowNode> | null>(null),
    generation = useRef(0),
    renderController = useRef<AbortController | null>(null),
    opener = useRef<HTMLElement | null>(null),
    fileInput = useRef<HTMLInputElement>(null),
    recoveryInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const report = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  const refresh = useCallback(async () => {
    const [rows, assets] = await Promise.all([
      listWorkspaces(),
      read<WorkspaceAsset[]>("assets"),
    ]);
    if (mounted.current) {
      setList(rows);
      setAssetList(assets);
    }
  }, []);
  const install = useCallback((doc: WorkspaceDocument, view: Viewport) => {
    saver.current?.dispose();
    const next = { past: [], present: doc, future: [] };
    current.current = { history: next, viewport: view };
    setHistory(next);
    setViewport(view);
    setStatus("保存済み");
    setError("");
    setInspector(undefined);
    setSelected(undefined);
    setPendingConfig(false);
    setPending(undefined);
    saver.current = new Autosave<Snapshot, WorkspaceDocument>(
      doc.revision,
      (snapshot, expected) =>
        saveWorkspace(snapshot.document, snapshot.viewport, expected),
      (state, e, saved) => {
        if (saved && current.current.history) {
          current.current.history = {
            ...current.current.history,
            present: {
              ...current.current.history.present,
              revision: saved.revision,
            },
          };
          setHistory(current.current.history);
        }
        if (mounted.current) {
          setStatus(state);
          setError(e ? (e instanceof Error ? e.message : String(e)) : "");
        }
      },
    );
  }, []);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    (async () => {
      const rows = await listWorkspaces();
      if (cancelled) return;
      const loaded = rows.length
        ? await loadWorkspace(rows[0].workflowId)
        : {
            document: await saveWorkspace(
              newWorkspace(),
              defaultViewport,
              null,
            ),
            viewport: defaultViewport,
          };
      if (!cancelled) {
        install(loaded.document, loaded.viewport);
        await refresh();
      }
    })().catch((e) => {
      if (!cancelled) report(e);
    });
    return () => {
      cancelled = true;
      mounted.current = false;
      renderController.current?.abort();
      saver.current?.dispose();
    };
  }, [install, refresh, report]);
  const doc = history?.present,
    node = doc?.nodes.find((n) => n.id === inspector);
  const edit = (value: WorkspaceDocument) => {
    const h = current.current.history;
    if (!h) return false;
    try {
      const next = parseWorkspace(value);
      if (JSON.stringify(next) === JSON.stringify(h.present)) return true;
      const result = {
        past: [...h.past, h.present].slice(-100),
        present: next,
        future: [],
      };
      current.current.history = result;
      setHistory(result);
      saver.current?.edit({
        document: next,
        viewport: current.current.viewport,
      });
      setError("");
      return true;
    } catch (e) {
      report(e);
      return false;
    }
  };
  const moveViewport = (view: Viewport) => {
    if (JSON.stringify(view) === JSON.stringify(current.current.viewport))
      return;
    current.current.viewport = view;
    setViewport(view);
    if (current.current.history)
      saver.current?.edit({
        document: current.current.history.present,
        viewport: view,
      });
  };
  const barrier = async () => {
    if (pendingConfig) throw new Error("設定の入力を確定してください");
    await saver.current?.flush();
  };
  const action = async (task: () => Promise<void>) => {
    if (operation) return;
    setOperation(true);
    try {
      await barrier();
      await task();
    } catch (e) {
      report(e);
    } finally {
      if (mounted.current) setOperation(false);
    }
  };
  const saveBundle = async (next: WorkspaceDocument, bundle: Bundle = {}) => {
    const saved = await saveWorkspace(
      next,
      current.current.viewport,
      saver.current!.revision,
      bundle,
    );
    const h = current.current.history!;
    const result = {
      past: [...h.past, h.present].slice(-100),
      present: saved,
      future: [],
    };
    // Keep history while replacing the coordinator's CAS baseline.
    const view = current.current.viewport;
    install(saved, view);
    setSelected(selected);
    setInspector(inspector);
    setPending(pending);
    current.current.history = result;
    setHistory(result);
    await refresh();
    return saved;
  };
  const reloadOutputs = useCallback(async (document: WorkspaceDocument) => {
    const entries = await Promise.all(
      document.nodes
        .filter((n) => n.type === "image-edit")
        .map(
          async (n) =>
            [n.id, await currentOutput(document.workflowId, n.id)] as const,
        ),
    );
    if (
      !mounted.current ||
      current.current.history?.present.workflowId !== document.workflowId
    )
      return;
    setOutputs(
      Object.fromEntries(
        entries.filter(
          (entry): entry is readonly [string, Artifact] => !!entry[1],
        ),
      ),
    );
  }, []);
  useEffect(() => {
    if (doc) void reloadOutputs(doc).catch(report);
  }, [doc, reloadOutputs, report]);
  useEffect(() => {
    const urls = Object.fromEntries(
      Object.entries(outputs).map(([id, a]) => [
        id,
        URL.createObjectURL(a.thumbnail),
      ]),
    );
    setThumbnails(urls);
    return () => Object.values(urls).forEach(URL.revokeObjectURL);
  }, [outputs]);
  useEffect(() => {
    if (node?.type !== "image-edit" || !doc) {
      setInputStatus("");
      return;
    }
    const controller = new AbortController();
    resolveInput(doc, node, controller.signal)
      .then((ref) => {
        if (!controller.signal.aborted)
          setInputStatus(
            ref ? `入力固定候補: ${ref.hash.slice(0, 12)}` : "空白から制作",
          );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setInputStatus(e.message);
      });
    return () => controller.abort();
  }, [node, doc]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (saver.current?.dirty || session || pendingConfig || operation) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [session, pendingConfig, operation]);
  useEffect(() => {
    if (!active) {
      generation.current++;
      renderController.current?.abort();
    }
  }, [active]);
  const switchTo = async (id: string) => {
    const loaded = await loadWorkspace(id);
    generation.current++;
    renderController.current?.abort();
    install(loaded.document, loaded.viewport);
    await refresh();
  };
  const startEditor = async (target: ImageEditNode) => {
    const expected = ++generation.current;
    renderController.current?.abort();
    const document = current.current.history!.present,
      found = document.nodes.find((n) => n.id === target.id);
    if (
      !found ||
      found.type !== "image-edit" ||
      found.config.editorDocumentId !== target.config.editorDocumentId
    )
      throw new Error("編集対象が変わりました");
    let editor = await loadEditor(target.config.editorDocumentId);
    let ref: AssetRef | null;
    try {
      ref = await resolveInput(document, target, new AbortController().signal);
    } catch (e) {
      if (expected !== generation.current || !active) return;
      if (
        editor.input ||
        editor.document.revision > 0 ||
        target.config.appliedRevisionId
      ) {
        setInputChoice({
          node: target,
          editor,
          ref: null,
          unavailable: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      throw e;
    }
    if (expected !== generation.current || !active) return;
    if (
      (editor.input && inputChanged(editor, ref)) ||
      (!editor.input &&
        ref &&
        (editor.document.revision > 0 || target.config.appliedRevisionId))
    ) {
      setInputChoice({ node: target, editor, ref });
      return;
    }
    if (!editor.input && ref) {
      editor = await saveDraft(
        await initializeInput(editor, ref, target.config.inputMode ?? ""),
        editor.revision,
      );
    }
    if (expected !== generation.current) return;
    setSession({ node: target, editor, generation: expected });
  };
  const chooseInput = async (kind: "keep" | "replace" | "rebuild") => {
    if (!inputChoice) return;
    const choice = inputChoice;
    setOperation(true);
    try {
      if (kind === "keep") {
        setSession({
          node: choice.node,
          editor: choice.editor,
          generation: ++generation.current,
        });
        setInputChoice(undefined);
        return;
      }
      if (choice.unavailable)
        throw new Error(
          "現在の入力を解決してから差し替え・作り直しを選んでください",
        );
      // Copy before replacing; the original editor and applied revision remain recoverable.
      const duplicate = await duplicateEditor(choice.node);
      duplicate.editor = await replaceInput(
        duplicate.editor,
        choice.ref,
        choice.node.config.inputMode ?? "",
        kind === "rebuild",
      );
      duplicate.node.config = {
        ...duplicate.node.config,
        appliedRevisionId: undefined,
        outputPageId: undefined,
        name: choice.node.config.name + "（新入力）",
      };
      await saveBundle(
        {
          ...current.current.history!.present,
          nodes: [...current.current.history!.present.nodes, duplicate.node],
        },
        { editors: [duplicate.editor] },
      );
      setInputChoice(undefined);
      setSession({
        node: duplicate.node,
        editor: duplicate.editor,
        generation: ++generation.current,
      });
    } catch (e) {
      report(e);
    } finally {
      setOperation(false);
    }
  };
  const backFromSession = async (
    record: EditorRecord,
    expected: number,
    pageId: string,
  ) => {
    const open = session;
    if (!open || generation.current !== open.generation)
      throw new Error("編集対象が変わりました");
    await barrier();
    const result = await applyEditor(
      current.current.history!.present,
      current.current.viewport,
      open.node.id,
      record,
      saver.current!.revision,
      expected,
      pageId,
    );
    const h = current.current.history!,
      next = {
        past: [...h.past, h.present].slice(-100),
        present: result.document,
        future: [],
      };
    const view = current.current.viewport;
    install(result.document, view);
    current.current.history = next;
    setHistory(next);
    setSelected(open.node.id);
    setInspector(open.node.id);
    setSession(undefined);
    await refresh();
    requestAnimationFrame(() => {
      const target = opener.current?.isConnected
        ? opener.current
        : window.document.querySelector<HTMLElement>(
            `[data-editor-opener="${open.node.id}"]`,
          );
      target?.focus();
    });
  };
  const renderOutput = async (target: ImageEditNode) => {
    if (generating) return;
    await barrier();
    if (!target.config.appliedRevisionId || !target.config.outputPageId)
      throw new Error("エディターで保存して適用してから更新してください");
    const expected = ++generation.current,
      controller = new AbortController();
    renderController.current = controller;
    setGenerating(target.id);
    setRenderError("");
    try {
      const revision = await loadRevision(target.config.appliedRevisionId);
      const key = await imageEditRenderKey(
        revision,
        target.config.outputPageId,
      );
      const cached = (await read<Artifact[]>("artifacts")).find(
        (a) => a.key === key,
      );
      const artifact =
        cached ??
        (await renderImageEdit(
          revision,
          target.config.outputPageId,
          controller.signal,
        ));
      controller.signal.throwIfAborted();
      if (expected !== generation.current) return;
      const adopted = await import("../../services/workspace/repository").then(
        (m) =>
          m.publishArtifact(
            current.current.history!.present.workflowId,
            target.id,
            artifact,
            controller.signal,
          ),
      );
      if (!adopted)
        throw new Error("対象版が変わったため生成結果を破棄しました");
      await reloadOutputs(current.current.history!.present);
    } catch (e) {
      if (mounted.current)
        setRenderError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setGenerating(undefined);
    }
  };
  const backup = async () => {
    await barrier();
    download(
      await backupWorkspace(current.current.history!.present.workflowId),
      "workflow.axfluxo-workspace.zip",
    );
  };
  const copyWorkflow = async (source: WorkspaceDocument) => {
    const editors: EditorRecord[] = [],
      revisions: NonNullable<Bundle["revisions"]> = [],
      nodes: WorkspaceNode[] = [],
      nodeIds = new Map<string, string>();
    for (const n of source.nodes) {
      if (n.type === "image-edit") {
        const pair = await duplicateEditor(n);
        editors.push(pair.editor);
        if (pair.revision) revisions.push(pair.revision);
        nodes.push({ ...pair.node, position: n.position });
        nodeIds.set(n.id, pair.node.id);
      } else {
        const id = crypto.randomUUID();
        nodes.push({ ...structuredClone(n), id });
        nodeIds.set(n.id, id);
      }
    }
    const copy = await saveWorkspace(
      {
        ...source,
        workflowId: crypto.randomUUID(),
        revision: 0,
        name: source.name.slice(0, 185) + " コピー",
        createdAt: now(),
        updatedAt: now(),
        nodes,
        edges: source.edges.map((e) => ({
          ...e,
          id: crypto.randomUUID(),
          sourceNodeId: nodeIds.get(e.sourceNodeId)!,
          targetNodeId: nodeIds.get(e.targetNodeId)!,
        })),
      },
      current.current.viewport,
      null,
      { editors, revisions },
    );
    install(copy, current.current.viewport);
    await refresh();
  };
  const selectPort = (target: WorkspaceNode, portId: string) => {
    const port = workspaceDefinitions[target.type].ports.find(
      (p) => p.id === portId,
    )!;
    if (port.direction === "output") {
      setPending({ nodeId: target.id, portId });
      return;
    }
    if (!pending || !doc) {
      report(new Error("先に出力端子を選択してください"));
      return;
    }
    const edge = {
        id: crypto.randomUUID(),
        sourceNodeId: pending.nodeId,
        sourcePortId: pending.portId,
        targetNodeId: target.id,
        targetPortId: portId,
      },
      reason = connectionError(doc, edge, workspaceDefinitions);
    if (reason) report(new Error(reason));
    else {
      edit({ ...doc, edges: [...doc.edges, edge] });
      setPending(undefined);
    }
  };
  const historyMove = (redo: boolean) => {
    const h = current.current.history;
    if (!h) return;
    const source = redo ? h.future : h.past;
    if (!source.length) return;
    const present = source[redo ? 0 : source.length - 1],
      next = redo
        ? { past: [...h.past, h.present], present, future: h.future.slice(1) }
        : {
            past: h.past.slice(0, -1),
            present,
            future: [h.present, ...h.future],
          };
    current.current.history = next;
    setHistory(next);
    saver.current?.edit({
      document: next.present,
      viewport: current.current.viewport,
    });
  };
  const addLegacyNode = (type: NodeType) => {
    if (!doc) return;
    const bounds = document
        .querySelector(".workspace-canvas .wf-canvas")
        ?.getBoundingClientRect(),
      position =
        bounds && flow.current
          ? flow.current.screenToFlowPosition({
              x: bounds.left + bounds.width / 2 - 120,
              y: bounds.top + bounds.height / 2 - 80,
            })
          : { x: 80, y: 80 };
    edit({ ...doc, nodes: [...doc.nodes, newNode(type, position)] });
  };
  const addEditor = async () => {
    const pair = newImageEdit({ x: 80 + (doc?.nodes.length ?? 0) * 30, y: 80 });
    await saveBundle(
      {
        ...current.current.history!.present,
        nodes: [...current.current.history!.present.nodes, pair.node],
      },
      { editors: [pair.editor] },
    );
    setSelected(pair.node.id);
    setInspector(pair.node.id);
  };
  const updateNode = (
    target: ImageEditNode,
    patch: Partial<ImageEditNode["config"]>,
  ) =>
    doc &&
    edit({
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === target.id
          ? { ...target, config: { ...target.config, ...patch } }
          : n,
      ),
    });
  const nodeStatus = Object.fromEntries(
    (doc?.nodes ?? []).map((n) => [
      n.id,
      n.type !== "image-edit"
        ? "設定のみ"
        : generating === n.id
          ? "画像生成中"
          : !n.config.appliedRevisionId
            ? "未適用"
            : !outputs[n.id]
              ? "出力未生成"
              : outputs[n.id].revisionId !== n.config.appliedRevisionId ||
                  outputs[n.id].pageId !== n.config.outputPageId
                ? "古い出力・更新必要"
                : "出力生成済み",
    ]),
  );
  const openImports = async () => {
    setImportOpen(true);
    const [workflows, projects] = await Promise.all([
      legacyWorkflows(),
      legacyProjects(),
    ]);
    setOldWorkflows(workflows);
    setOldProjects(projects);
    setMigrationLabels(
      Object.fromEntries(
        await Promise.all(
          workflows.map(async (w) => [
            w.workflowId,
            await migrationState(w.workflowId, w.revision),
          ]),
        ),
      ),
    );
  };
  return (
    <>
      <div
        hidden={!!session}
        inert={session ? true : undefined}
        className="workflow-first"
        aria-label="Workflowワークスペース"
      >
        <aside className="workspace-nav">
          <b>AxFluxo</b>
          <button aria-current="page">Workflow</button>
          <button
            onClick={() =>
              void action(async () => {
                generation.current++;
                renderController.current?.abort();
                onLegacy();
              })
            }
          >
            旧Studioを開く
          </button>
          <button
            onClick={() =>
              void action(async () => {
                const d = await saveWorkspace(
                  newWorkspace(),
                  defaultViewport,
                  null,
                );
                install(d, defaultViewport);
                await refresh();
              })
            }
            disabled={operation}
          >
            新しいWorkflow
          </button>
          <button onClick={() => void action(openImports)} disabled={operation}>
            旧作品を取り込む
          </button>
          <p>
            端末内保存。画像コピーで容量が増えます。端末へのバックアップも保存してください。
          </p>
          {active && <Account />}
        </aside>
        <main className="workspace-main" inert={operation ? true : undefined}>
          <section
            className="workflow"
            aria-label="Workflow"
            onKeyDown={(e) => {
              if (
                (e.target as HTMLElement).closest(
                  "input,textarea,select,[contenteditable=true]",
                ) ||
                e.nativeEvent.isComposing
              )
                return;
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
                e.preventDefault();
                historyMove(e.shiftKey);
              }
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                void barrier().catch(report);
              }
            }}
          >
            <div className="wf-toolbar">
              <label>
                Workflow
                <select
                  aria-label="Workflowを選択"
                  value={doc?.workflowId ?? ""}
                  disabled={operation}
                  onChange={(e) => void action(() => switchTo(e.target.value))}
                >
                  {list.map((w) => (
                    <option key={w.workflowId} value={w.workflowId}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Workflow名
                <ConfigField
                  value={doc?.name ?? ""}
                  onDraftChange={setPendingConfig}
                  onChange={(name) =>
                    !!doc && !!name.trim() && edit({ ...doc, name })
                  }
                />
              </label>
              <span role="status">
                {pendingConfig ? "入力未確定・未保存" : status}
              </span>
              <button
                disabled={!history?.past.length || operation}
                onClick={() => historyMove(false)}
              >
                元に戻す
              </button>
              <button
                disabled={!history?.future.length || operation}
                onClick={() => historyMove(true)}
              >
                やり直す
              </button>
              <button
                onClick={() =>
                  void flow.current?.fitView({
                    padding: 0.2,
                    minZoom: 0.25,
                    maxZoom: 2,
                  })
                }
              >
                全体表示
              </button>
              <button onClick={() => void flow.current?.zoomTo(1)}>
                100%表示
              </button>
              <button
                disabled={!doc || operation}
                onClick={() => doc && edit(arrange(doc))}
              >
                自動整列
              </button>
              <NodePalette
                onAdd={addLegacyNode}
                onAddImageEdit={() => void action(addEditor)}
              />
              <button
                disabled={!doc || operation}
                onClick={() => void action(addEditor)}
              >
                ＋ 画像編集
              </button>
              <button
                disabled={!doc || operation}
                onClick={() => void action(backup)}
              >
                Workflowバックアップ
              </button>
              <button
                disabled={operation}
                onClick={() => recoveryInput.current?.click()}
              >
                Workflowバックアップを復元
              </button>
              <button disabled title="Workflow全体の実行エンジンは未実装">
                全体実行（今後対応）
              </button>
              <button
                disabled={!doc || operation}
                onClick={() =>
                  void action(async () => {
                    const records =
                      await read<
                        { workflowId: string; document: WorkspaceDocument }[]
                      >("recovery");
                    const rows = records
                      .filter((r) => r.workflowId === doc!.workflowId)
                      .sort(
                        (a, b) => b.document.revision - a.document.revision,
                      );
                    setRecoveries(rows.map((r) => r.document));
                  })
                }
              >
                復旧履歴
              </button>
            </div>
            {error && (
              <div className="wf-notice" role="alert">
                {error}
                <button
                  onClick={() => void saver.current?.retry().catch(report)}
                >
                  保存を再試行
                </button>
                {status === "競合・未保存" && doc && (
                  <>
                    <button
                      disabled={pendingConfig}
                      onClick={() =>
                        void switchTo(doc.workflowId).catch(report)
                      }
                    >
                      保存版を再読込
                    </button>
                    <button
                      disabled={pendingConfig}
                      onClick={() => void copyWorkflow(doc).catch(report)}
                    >
                      別コピーとして保存
                    </button>
                  </>
                )}
              </div>
            )}
            {pending && (
              <p className="wf-notice">
                出力を選択中。接続先の入力を選んでください。
                <button onClick={() => setPending(undefined)}>
                  接続を取消
                </button>
              </p>
            )}
            {recoveries.length > 0 && (
              <div className="wf-recovery">
                {recoveries.slice(0, 10).map((d) => (
                  <button
                    key={d.revision}
                    disabled={operation || status !== "保存済み"}
                    onClick={() => void action(() => copyWorkflow(d))}
                  >
                    revision {d.revision} を別コピー復旧
                  </button>
                ))}
                <button onClick={() => setRecoveries([])}>履歴を閉じる</button>
              </div>
            )}
            <div className="wf-body workspace-canvas">
              {doc && (
                <WorkflowCanvas
                  document={doc}
                  viewport={viewport}
                  selected={selected}
                  nodeDefinitions={workspaceDefinitions}
                  nodeStatus={nodeStatus}
                  nodeTitles={Object.fromEntries(
                    doc.nodes.map((n) => [
                      n.id,
                      n.type === "image-edit"
                        ? n.config.name
                        : workspaceDefinitions[n.type].label,
                    ]),
                  )}
                  thumbnails={thumbnails}
                  onEdit={edit}
                  onViewport={moveViewport}
                  onInspect={(id) => {
                    if (generating) {
                      generation.current++;
                      renderController.current?.abort();
                    }
                    setSelected(id);
                    setInspector(id);
                  }}
                  onSelect={(id) => {
                    if (generating && selected !== id) {
                      generation.current++;
                      renderController.current?.abort();
                    }
                    setSelected(id);
                  }}
                  onError={setError}
                  onInit={(instance) => {
                    flow.current = instance;
                  }}
                />
              )}
              {doc && node && node.type !== "image-edit" && (
                <NodeInspector
                  key={node.id}
                  node={node}
                  document={{
                    ...doc,
                    schemaVersion: 1,
                    nodes: doc.nodes.filter(
                      (n): n is WorkflowNode => n.type !== "image-edit",
                    ),
                  }}
                  nodeDefinitions={workspaceDefinitions}
                  assetChoices={assetList}
                  allNodes={doc.nodes}
                  pending={pending}
                  onPort={selectPort}
                  onDraftChange={setPendingConfig}
                  onChange={(config) =>
                    edit({
                      ...doc,
                      nodes: doc.nodes.map((n) =>
                        n.id === node.id ? { ...node, config } : n,
                      ),
                    })
                  }
                  onClose={() => setInspector(undefined)}
                  onDelete={() => {
                    edit({
                      ...doc,
                      nodes: doc.nodes.filter((n) => n.id !== node.id),
                      edges: doc.edges.filter(
                        (e) =>
                          e.sourceNodeId !== node.id &&
                          e.targetNodeId !== node.id,
                      ),
                    });
                    setInspector(undefined);
                  }}
                  onDuplicate={() => {
                    edit({
                      ...doc,
                      nodes: [
                        ...doc.nodes,
                        {
                          ...structuredClone(node),
                          id: crypto.randomUUID(),
                          position: {
                            x: node.position.x + 40,
                            y: node.position.y + 40,
                          },
                        },
                      ],
                    });
                  }}
                  onDisconnect={(id) =>
                    edit({
                      ...doc,
                      edges: doc.edges.filter((e) => e.id !== id),
                    })
                  }
                />
              )}
              {doc && node?.type === "image-edit" && (
                <aside
                  className="wf-inspector"
                  aria-label="画像編集ノード詳細"
                  tabIndex={-1}
                >
                  <header>
                    <h2>画像編集</h2>
                    <button
                      aria-label="ノード設定を閉じる"
                      onClick={() => setInspector(undefined)}
                    >
                      閉じる
                    </button>
                  </header>
                  <label>
                    ノード名
                    <ConfigField
                      value={node.config.name}
                      onDraftChange={setPendingConfig}
                      onChange={(name) =>
                        !!name.trim() && !!updateNode(node, { name })
                      }
                    />
                  </label>
                  <label>
                    入力方法
                    <select
                      aria-label="入力方法"
                      value={node.config.inputMode ?? ""}
                      onChange={(e) =>
                        updateNode(node, {
                          inputMode: e.target.value as
                            "blank" | "connected" | "selected",
                          selectedAssetRef:
                            e.target.value === "selected" && assetList[0]
                              ? {
                                  assetId: assetList[0].id,
                                  hash: assetList[0].hash,
                                }
                              : undefined,
                        })
                      }
                    >
                      <option value="" disabled>
                        未設定
                      </option>
                      <option value="connected">接続入力</option>
                      <option value="selected">選択素材</option>
                      <option value="blank">空白から制作</option>
                    </select>
                  </label>
                  {node.config.inputMode === "selected" && (
                    <label>
                      選択素材
                      <select
                        aria-label="入力素材"
                        value={node.config.selectedAssetRef?.assetId ?? ""}
                        onChange={(e) => {
                          const asset = assetList.find(
                            (a) => a.id === e.target.value,
                          );
                          if (asset)
                            updateNode(node, {
                              selectedAssetRef: {
                                assetId: asset.id,
                                hash: asset.hash,
                              },
                            });
                        }}
                      >
                        {assetList.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} ({a.hash.slice(0, 8)})
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button onClick={() => fileInput.current?.click()}>
                    入力画像を取り込む
                  </button>
                  <p role="note">{inputStatus}</p>
                  <p>
                    入力方式: {node.config.inputMode ?? "未設定"} /{" "}
                    {node.config.selectedAssetRef?.hash.slice(0, 12) ??
                      doc.edges.find((e) => e.targetNodeId === node.id)
                        ?.sourceNodeId ??
                      "参照なし"}
                  </p>
                  <EditorSummary node={node} />
                  <p>{nodeStatus[node.id]}</p>
                  <button
                    disabled={operation || !!generating}
                    data-editor-opener={node.id}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      void action(() => startEditor(node));
                    }}
                  >
                    画像エディターを開く
                  </button>
                  <button
                    disabled={
                      operation ||
                      !!generating ||
                      !node.config.appliedRevisionId
                    }
                    onClick={() => void renderOutput(node).catch(report)}
                  >
                    出力画像を更新
                  </button>
                  {generating === node.id && (
                    <button
                      onClick={() => {
                        generation.current++;
                        renderController.current?.abort();
                      }}
                    >
                      画像生成をキャンセル
                    </button>
                  )}
                  {renderError && (
                    <p role="alert">
                      {renderError}
                      <button
                        onClick={() => void renderOutput(node).catch(report)}
                      >
                        画像生成を再試行
                      </button>
                    </p>
                  )}
                  {outputs[node.id] && (
                    <button
                      onClick={() =>
                        download(outputs[node.id].blob, "workflow-output.png")
                      }
                    >
                      {nodeStatus[node.id].startsWith("古い")
                        ? "古い出力をダウンロード"
                        : "出力画像をダウンロード"}
                    </button>
                  )}
                  <OutputPage
                    node={node}
                    onChange={(pageId) => {
                      updateNode(node, { outputPageId: pageId });
                    }}
                  />
                  <h3>端子を選択して接続</h3>
                  {workspaceDefinitions[node.type].ports.map((p) => (
                    <button
                      className="wf-port-button"
                      key={p.id}
                      aria-pressed={
                        pending?.nodeId === node.id && pending.portId === p.id
                      }
                      onClick={() => selectPort(node, p.id)}
                    >
                      {p.direction === "input" ? "入力 ←" : "出力 →"} {p.label}{" "}
                      ({p.type})
                    </button>
                  ))}
                  <h3>接続一覧</h3>
                  {doc.edges
                    .filter(
                      (e) =>
                        e.sourceNodeId === node.id ||
                        e.targetNodeId === node.id,
                    )
                    .map((e) => (
                      <button
                        key={e.id}
                        onClick={() =>
                          edit({
                            ...doc,
                            edges: doc.edges.filter((x) => x.id !== e.id),
                          })
                        }
                      >
                        接続解除 {e.id}
                      </button>
                    ))}
                  <div className="button-row">
                    <button
                      disabled={operation}
                      onClick={() =>
                        void action(async () => {
                          const pair = await duplicateEditor(node);
                          await saveBundle(
                            {
                              ...current.current.history!.present,
                              nodes: [
                                ...current.current.history!.present.nodes,
                                pair.node,
                              ],
                            },
                            {
                              editors: [pair.editor],
                              revisions: pair.revision ? [pair.revision] : [],
                            },
                          );
                        })
                      }
                    >
                      複製
                    </button>
                    <button
                      disabled={operation}
                      onClick={() => {
                        edit({
                          ...doc,
                          nodes: doc.nodes.filter((n) => n.id !== node.id),
                          edges: doc.edges.filter(
                            (e) =>
                              e.sourceNodeId !== node.id &&
                              e.targetNodeId !== node.id,
                          ),
                        });
                        setInspector(undefined);
                      }}
                    >
                      削除
                    </button>
                  </div>
                </aside>
              )}
            </div>
            <details className="wf-node-list">
              <summary>ノード一覧・キーボード操作</summary>
              {doc?.nodes.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    setSelected(n.id);
                    setInspector(n.id);
                  }}
                >
                  {n.type === "image-edit"
                    ? n.config.name
                    : workspaceDefinitions[n.type].label}{" "}
                  の詳細
                </button>
              ))}
            </details>
          </section>
        </main>
        <input
          ref={fileInput}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0],
              target = node;
            e.target.value = "";
            if (file && target?.type === "image-edit")
              void action(async () => {
                const asset = await importImage(file),
                  ref = await storeAsset(asset);
                await refresh();
                updateNode(target, {
                  inputMode: "selected",
                  selectedAssetRef: ref,
                });
              });
          }}
        />
        <input
          ref={recoveryInput}
          type="file"
          hidden
          accept=".zip"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file)
              void action(async () => {
                const id = await restoreWorkspace(file);
                await switchTo(id);
              });
          }}
        />
        {importOpen && (
          <WorkspaceDialog
            label="旧作品取り込み"
            onClose={() => {
              if (!operation) setImportOpen(false);
            }}
          >
            <h2>旧作品を独立したコピーとして取り込む</h2>
            <p>
              元のDBと作品は変更しません。必要画像を新DBへコピーするため容量が増えます。
            </p>
            <h3>旧Workflow</h3>
            {oldWorkflows.map((w) => (
              <button
                disabled={operation}
                key={w.workflowId}
                onClick={() =>
                  void action(async () => {
                    const id = await importLegacyWorkflow(w.workflowId);
                    await switchTo(id);
                    setImportOpen(false);
                  })
                }
              >
                {w.name}: {migrationLabels[w.workflowId]}
              </button>
            ))}
            <h3>旧Studio</h3>
            {oldProjects.map((p) => (
              <button
                key={p.id}
                disabled={operation}
                onClick={() =>
                  void action(async () => {
                    const pair = await prepareLegacyProject(p);
                    await saveBundle(
                      {
                        ...current.current.history!.present,
                        nodes: [
                          ...current.current.history!.present.nodes,
                          pair.node,
                        ],
                      },
                      { editors: [pair.editor], assets: pair.assets },
                    );
                    setImportOpen(false);
                    setInspector(pair.node.id);
                  })
                }
              >
                {p.name} を画像編集ノードへコピー
              </button>
            ))}
            <button disabled={operation} onClick={() => setImportOpen(false)}>
              閉じる
            </button>
          </WorkspaceDialog>
        )}
        {inputChoice && (
          <WorkspaceDialog
            label="入力変更の選択"
            onClose={() => {
              if (!operation) setInputChoice(undefined);
            }}
          >
            <h2>
              {inputChoice.unavailable
                ? "現在の入力を解決できません"
                : "上流入力が変わりました"}
            </h2>
            {inputChoice.unavailable && (
              <p role="alert">
                {inputChoice.unavailable}。保存済みの固定入力で再開できます。
              </p>
            )}
            <p>
              文字・図形・別画像を自動変更しません。差し替え・作り直しは別ノードへコピーし、元の文書を保持します。
            </p>
            <button
              disabled={operation}
              onClick={() => void chooseInput("keep")}
            >
              現在の固定入力を維持
            </button>
            <button
              disabled={operation || !!inputChoice.unavailable}
              onClick={() => void chooseInput("replace")}
            >
              コピー後に入力レイヤーのみ差し替え
            </button>
            <button
              disabled={operation || !!inputChoice.unavailable}
              onClick={() => void chooseInput("rebuild")}
            >
              コピーして新入力から作り直す
            </button>
            <button onClick={() => setInputChoice(undefined)}>
              キャンセル
            </button>
          </WorkspaceDialog>
        )}
      </div>
      {session && (
        <ImageEditSession
          key={`${session.editor.id}:${session.generation}`}
          initial={session.editor}
          initialPageId={session.node.config.outputPageId}
          nodeName={session.node.config.name}
          onApply={backFromSession}
          onBackup={backup}
          onReload={async () => {
            const fresh = await loadWorkspace(
              current.current.history!.present.workflowId,
            );
            const target = fresh.document.nodes.find(
              (n) => n.id === session.node.id,
            );
            if (
              !target ||
              target.type !== "image-edit" ||
              target.config.editorDocumentId !== session.editor.id
            )
              throw new Error(
                "元ノードは変更/削除されています。別コピーとして保存してください",
              );
            const editor = await loadEditor(target.config.editorDocumentId);
            install(fresh.document, fresh.viewport);
            setSession({
              node: target,
              editor,
              generation: ++generation.current,
            });
          }}
          onSaveCopy={async (record) => {
            await barrier();
            const fresh = await loadWorkspace(
              current.current.history!.present.workflowId,
            );
            if (fresh.document.revision !== saver.current!.revision)
              install(fresh.document, current.current.viewport);
            const pair = await duplicateEditor(session.node);
            pair.editor = {
              ...structuredClone(record),
              id: pair.editor.id,
              revision: 0,
              document: {
                ...structuredClone(record.document),
                id: crypto.randomUUID(),
              },
            };
            pair.node.config = {
              ...pair.node.config,
              appliedRevisionId: undefined,
              outputPageId: undefined,
            };
            await saveBundle(
              {
                ...current.current.history!.present,
                nodes: [...current.current.history!.present.nodes, pair.node],
              },
              { editors: [pair.editor] },
            );
            setSession({
              node: pair.node,
              editor: pair.editor,
              generation: ++generation.current,
            });
          }}
        />
      )}
    </>
  );
}
function EditorSummary({ node }: { node: ImageEditNode }) {
  const [text, setText] = useState("読込中");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const draft = await loadEditor(node.config.editorDocumentId);
      const applied = node.config.appliedRevisionId
        ? await loadRevision(node.config.appliedRevisionId)
        : undefined;
      if (!cancelled)
        setText(
          !applied
            ? "作業版あり・未適用"
            : JSON.stringify(draft.document) !==
                  JSON.stringify(applied.document) ||
                JSON.stringify(draft.assets) !== JSON.stringify(applied.assets)
              ? "作業版に未適用の変更あり"
              : "作業版と適用版は一致",
        );
    })().catch((e) => {
      if (!cancelled) setText(e.message);
    });
    return () => {
      cancelled = true;
    };
  }, [node]);
  return <p aria-label="編集文書状態">{text}</p>;
}
function OutputPage({
  node,
  onChange,
}: {
  node: ImageEditNode;
  onChange: (id: string) => void;
}) {
  const [pages, setPages] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!node.config.appliedRevisionId) {
        if (!cancelled) setPages([]);
        return;
      }
      const revision = await loadRevision(node.config.appliedRevisionId);
      if (!cancelled) setPages(revision.document.pages);
    })().catch(() => {
      if (!cancelled) setPages([]);
    });
    return () => {
      cancelled = true;
    };
  }, [node.config.appliedRevisionId]);
  return (
    <label>
      出力対象ページ
      <select
        aria-label="出力対象ページ"
        value={node.config.outputPageId ?? ""}
        disabled={!pages.length}
        onChange={(e) => onChange(e.target.value)}
      >
        {!pages.length && <option value="">未適用</option>}
        {pages.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
