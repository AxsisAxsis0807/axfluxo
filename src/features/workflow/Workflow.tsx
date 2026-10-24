"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import {
  arrange,
  commit,
  deleteNode,
  duplicateNode,
  redo,
  undo,
  type History,
} from "../../domain/workflow/commands";
import { connectionError } from "../../domain/workflow/connections";
import {
  definitions,
  newNode,
  newWorkflow,
  type Viewport,
  type WorkflowDocument,
  type WorkflowNode,
} from "../../domain/workflow/schema";
import {
  latestWorkflowId,
  loadWorkflow,
  recoveryHistory,
} from "../../services/workflow/repository";
import {
  WorkflowAutosave,
  type SaveStatus,
} from "../../services/workflow/autosave";
import WorkflowCanvas, { type FlowNode } from "./WorkflowCanvas";
import NodePalette from "./NodePalette";
import NodeInspector, { type Endpoint } from "./NodeInspector";
import "./workflow.css";
export default function Workflow() {
  const [history, setHistory] = useState<History>();
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [status, setStatus] = useState<SaveStatus>("未保存");
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [pendingConfig, setPendingConfig] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [inspector, setInspector] = useState<string>();
  const [pending, setPending] = useState<Endpoint>();
  const [recoveries, setRecoveries] = useState<WorkflowDocument[]>([]);
  const saver = useRef<WorkflowAutosave | null>(null);
  const flow = useRef<Pick<
    ReactFlowInstance<FlowNode>,
    "fitView" | "zoomTo" | "screenToFlowPosition" | "setViewport"
  > | null>(null);
  const current = useRef({ history, viewport });
  current.current = { history, viewport };
  const notify = useCallback((status: SaveStatus, error?: unknown) => {
    setStatus(status);
    setSaveError(
      error ? (error instanceof Error ? error.message : String(error)) : "",
    );
  }, []);
  const install = useCallback(
    (d: WorkflowDocument, v: Viewport, revision: number | null) => {
      saver.current?.dispose();
      saver.current = new WorkflowAutosave(revision, notify);
      const next: History = { past: [], present: d, future: [] };
      current.current = { history: next, viewport: v };
      setHistory(next);
      setViewport(v);
      setError("");
      setSaveError("");
      setPendingConfig(false);
      setSelected(undefined);
      setInspector(undefined);
      setPending(undefined);
      setRecoveries([]);
      setStatus(revision === null ? "未保存" : "保存済み");
      if (revision === null) saver.current.edit(d, v);
    },
    [notify],
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = await latestWorkflowId(),
        loaded = id ? await loadWorkflow(id) : undefined;
      if (!cancelled)
        install(
          loaded?.document ?? newWorkflow(),
          loaded?.viewport ?? { x: 0, y: 0, zoom: 1 },
          loaded?.document?.revision ?? null,
        );
    })().catch((e) => {
      if (!cancelled)
        setError(
          `読み込み失敗。元データは保持されています。${e instanceof Error ? e.message : e}`,
        );
    });
    return () => {
      cancelled = true;
      void saver.current?.flush();
      saver.current?.dispose();
    };
  }, [install]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if (status !== "保存済み" || pendingConfig) e.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [status, pendingConfig]);
  function change(next: History) {
    if (next === current.current.history) return;
    current.current.history = next;
    setHistory(next);
    saver.current?.edit(next.present, current.current.viewport);
  }
  const edit = (d: WorkflowDocument) => {
    const h = current.current.history;
    if (!h) return false;
    try {
      change(commit(h, d));
      setError("");
      return true;
    } catch {
      setError(
        "設定値を確認してください。入力中の値はまだ保存されていません。",
      );
      return false;
    }
  };
  function setView(v: Viewport) {
    if (JSON.stringify(current.current.viewport) === JSON.stringify(v)) return;
    current.current.viewport = v;
    setViewport(v);
    if (current.current.history)
      saver.current?.edit(current.current.history.present, v);
  }
  function copy(d: WorkflowDocument) {
    const now = new Date().toISOString();
    install(
      {
        ...structuredClone(d),
        workflowId: crypto.randomUUID(),
        revision: 0,
        name: `${d.name.slice(0, 190)} コピー`,
        createdAt: now,
        updatedAt: now,
      },
      current.current.viewport,
      null,
    );
  }
  function selectPort(node: WorkflowNode, portId: string) {
    const port = definitions[node.type].ports.find((p) => p.id === portId)!;
    if (port.direction === "output") {
      setPending({ nodeId: node.id, portId });
      setError("");
      return;
    }
    if (!pending || !history) {
      setError("先に出力端子を選択してください");
      return;
    }
    const edge = {
      id: crypto.randomUUID(),
      sourceNodeId: pending.nodeId,
      sourcePortId: pending.portId,
      targetNodeId: node.id,
      targetPortId: portId,
    };
    const reason = connectionError(history.present, edge);
    if (reason) setError(reason);
    else {
      edit({ ...history.present, edges: [...history.present.edges, edge] });
      setPending(undefined);
      setError("");
    }
  }
  const doc = history?.present,
    node = doc?.nodes.find((n) => n.id === inspector);
  return (
    <section
      className="workflow"
      aria-label="Workflow"
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("input,textarea,select,[contenteditable=true]"))
          return;
        if (
          (e.ctrlKey || e.metaKey) &&
          e.key.toLowerCase() === "z" &&
          history
        ) {
          e.preventDefault();
          change(e.shiftKey ? redo(history) : undo(history));
        }
      }}
    >
      <div className="wf-toolbar">
        <label>
          Workflow名
          <input
            aria-label="Workflow名"
            value={doc?.name ?? ""}
            disabled={!doc}
            maxLength={200}
            onChange={(e) => {
              if (doc && e.target.value.trim())
                edit({ ...doc, name: e.target.value });
            }}
          />
        </label>
        <span role="status">
          {pendingConfig ? "入力未確定・未保存" : status}
        </span>
        <button disabled title="実行エンジンは後続フェーズ">
          実行（今後対応）
        </button>
        <button
          disabled={!history?.past.length}
          onClick={() => history && change(undo(history))}
        >
          元に戻す
        </button>
        <button
          disabled={!history?.future.length}
          onClick={() => history && change(redo(history))}
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
        <button onClick={() => void flow.current?.zoomTo(1)}>100%表示</button>
        <button
          disabled={!doc?.nodes.length}
          onClick={() => doc && edit(arrange(doc))}
        >
          自動整列
        </button>
        <button
          disabled={!doc}
          onClick={() => {
            if (doc)
              void recoveryHistory(doc.workflowId)
                .then(setRecoveries)
                .catch((e) => setError(String(e)));
          }}
        >
          復旧履歴
        </button>
        {doc && (
          <NodePalette
            onAdd={(type) => {
              const bounds = window.document
                .querySelector(".wf-canvas")
                ?.getBoundingClientRect();
              const position =
                bounds && flow.current
                  ? flow.current.screenToFlowPosition({
                      x: bounds.left + bounds.width / 2 - 120,
                      y: bounds.top + bounds.height / 2 - 80,
                    })
                  : { x: 80, y: 80 };
              edit({ ...doc, nodes: [...doc.nodes, newNode(type, position)] });
            }}
          />
        )}
      </div>
      {(error || saveError) && (
        <div role="alert" className="wf-notice">
          {error || saveError}
        </div>
      )}
      {status === "競合・未保存" && doc && (
        <div className="wf-notice">
          <button
            onClick={() =>
              void loadWorkflow(doc.workflowId)
                .then((v) => {
                  if (v.document)
                    install(v.document, v.viewport, v.document.revision);
                })
                .catch((e) => setError(String(e)))
            }
          >
            保存版を再読込（現在の編集を破棄）
          </button>
          <button disabled={pendingConfig} onClick={() => copy(doc)}>
            別コピーとして保存
          </button>
        </div>
      )}
      {status === "保存失敗・未保存" && (
        <button onClick={() => saver.current?.retry()}>保存を再試行</button>
      )}
      {recoveries.length > 0 && (
        <div className="wf-recovery">
          {(status !== "保存済み" || pendingConfig) && (
            <p>現在の編集を保存してからコピー復旧できます。</p>
          )}
          {recoveries.map((d) => (
            <button
              key={d.revision}
              disabled={status !== "保存済み" || pendingConfig}
              onClick={() => copy(d)}
            >
              revision {d.revision} をコピー復旧
            </button>
          ))}
          <button onClick={() => setRecoveries([])}>履歴を閉じる</button>
        </div>
      )}
      {pending && (
        <p className="wf-notice">
          出力を選択中。接続先ノードの設定で入力を選んでください。
          <button onClick={() => setPending(undefined)}>接続を取消</button>
        </p>
      )}
      <div className="wf-body">
        {doc && (
          <WorkflowCanvas
            document={doc}
            viewport={viewport}
            selected={selected}
            onEdit={edit}
            onViewport={setView}
            onInspect={(id) => {
              setSelected(id);
              setInspector(id);
            }}
            onSelect={setSelected}
            onError={setError}
            onInit={(instance) => {
              flow.current = instance;
            }}
          />
        )}
        {doc && node && (
          <NodeInspector
            key={node.id}
            node={node}
            document={doc}
            pending={pending}
            onPort={selectPort}
            onClose={() => setInspector(undefined)}
            onChange={(config) =>
              edit({
                ...doc,
                nodes: doc.nodes.map((n) =>
                  n.id === node.id ? { ...n, config } : n,
                ),
              })
            }
            onDraftChange={setPendingConfig}
            onDelete={() => {
              edit(deleteNode(doc, node.id));
              setInspector(undefined);
              setSelected(undefined);
              if (pending?.nodeId === node.id) setPending(undefined);
            }}
            onDuplicate={() => edit(duplicateNode(doc, node.id))}
            onDisconnect={(id) =>
              edit({ ...doc, edges: doc.edges.filter((e) => e.id !== id) })
            }
          />
        )}
      </div>
      {doc && (
        <details className="wf-node-list">
          <summary>ノード一覧・キーボード操作</summary>
          {doc.nodes.map((n) => (
            <button
              key={n.id}
              onClick={() => {
                setSelected(n.id);
                setInspector(n.id);
              }}
            >
              {definitions[n.type].label} の詳細
            </button>
          ))}
        </details>
      )}
    </section>
  );
}
