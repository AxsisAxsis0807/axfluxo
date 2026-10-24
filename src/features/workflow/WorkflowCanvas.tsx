"use client";
import { useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Connection,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  definitions,
  type WorkflowDocument,
  type WorkflowNode,
  type Viewport,
} from "../../domain/workflow/schema";
import { connectionError } from "../../domain/workflow/connections";
export type FlowNode = Node<
  { node: WorkflowNode; inspect: (id: string) => void },
  "workflow"
>;
function WorkflowCard({ data }: NodeProps<FlowNode>) {
  const definition = definitions[data.node.type];
  return (
    <article className="wf-node">
      <header className="wf-drag">
        <b>{definition.label}</b>
        <span>設定のみ</span>
      </header>
      <div className="wf-ports">
        {definition.ports.map((p, i) => (
          <div key={p.id} className={`wf-port wf-${p.direction}`}>
            <Handle
              id={p.id}
              type={p.direction === "input" ? "target" : "source"}
              position={
                p.direction === "input" ? Position.Left : Position.Right
              }
              style={{ top: 68 + i * 44 }}
              aria-label={`${definition.label} ${p.label} ${p.direction === "input" ? "入力" : "出力"} ${p.type}`}
            />
            <span>
              {p.direction === "input" ? "←" : "→"} {p.label}{" "}
              <small>{p.type}</small>
            </span>
          </div>
        ))}
      </div>
      <button
        className="nodrag nopan"
        onClick={() => data.inspect(data.node.id)}
        aria-label={`${definition.label}の設定`}
      >
        設定を開く
      </button>
    </article>
  );
}
const nodeTypes = { workflow: WorkflowCard };
export default function WorkflowCanvas({
  document: doc,
  viewport,
  selected,
  onEdit,
  onViewport,
  onInspect,
  onSelect,
  onError,
  onInit,
}: {
  document: WorkflowDocument;
  viewport: Viewport;
  selected?: string;
  onEdit: (d: WorkflowDocument) => void;
  onViewport: (v: Viewport) => void;
  onInspect: (id: string) => void;
  onSelect: (id: string) => void;
  onError: (s: string) => void;
  onInit: (instance: ReactFlowInstance<FlowNode>) => void;
}) {
  const cancelling = useRef(false);
  const pointers = useRef(new Set<number>());
  const [drag, setDrag] = useState<Record<string, { x: number; y: number }>>(
    {},
  );
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const gesture = useRef(false),
    invalid = useRef("");
  const nodes: FlowNode[] = doc.nodes.map((n) => ({
    id: n.id,
    type: "workflow",
    dragHandle: ".wf-drag",
    position: drag[n.id] ?? n.position,
    selected: n.id === selected,
    ariaLabel: definitions[n.type].label,
    data: { node: n, inspect: onInspect },
  }));
  const edgeFor = (c: Connection | Edge) => ({
    sourceNodeId: c.source,
    sourcePortId: c.sourceHandle ?? "",
    targetNodeId: c.target,
    targetPortId: c.targetHandle ?? "",
  });
  function finishDrag() {
    if (!gesture.current) return;
    gesture.current = false;
    const positions = dragRef.current;
    onEdit({
      ...doc,
      nodes: doc.nodes.map((n) =>
        positions[n.id] ? { ...n, position: positions[n.id] } : n,
      ),
    });
    setDrag({});
  }
  function cancelGesture() {
    finishDrag();
    pointers.current.clear();
    // End document/window drag listeners synchronously. Keep the Flow mounted:
    // native touchcancel still needs to reach D3's touch gesture bookkeeping.
    cancelling.current = true;
    window.document.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, view: window }),
    );
    cancelling.current = false;
  }
  return (
    <div
      className="wf-canvas"
      aria-label="Workflowキャンバス"
      onPointerDownCapture={(e) => {
        pointers.current.add(e.pointerId);
        if (pointers.current.size > 1) finishDrag();
      }}
      onPointerUpCapture={(e) => {
        pointers.current.delete(e.pointerId);
      }}
      onPointerCancel={cancelGesture}
      onLostPointerCapture={(e) => {
        if (pointers.current.has(e.pointerId)) {
          cancelGesture();
        }
      }}
    >
      <ReactFlow<FlowNode>
        nodes={nodes}
        edges={doc.edges.map((e) => ({
          id: e.id,
          source: e.sourceNodeId,
          sourceHandle: e.sourcePortId,
          target: e.targetNodeId,
          targetHandle: e.targetPortId,
          ariaLabel: "Workflow接続",
        }))}
        nodeTypes={nodeTypes}
        colorMode="dark"
        viewport={viewport}
        onViewportChange={onViewport}
        minZoom={0.25}
        maxZoom={2}
        panOnDrag={[0, 1]}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        connectOnClick
        connectionRadius={30}
        deleteKeyCode={null}
        nodesConnectable
        edgesReconnectable={false}
        onInit={onInit}
        onMoveEnd={(_, v) => onViewport(v)}
        onNodeDragStart={() => {
          gesture.current = true;
        }}
        onNodeDragStop={finishDrag}
        onNodesChange={(changes) => {
          if (cancelling.current) return;
          for (const c of changes)
            if (c.type === "select" && c.selected) onSelect(c.id);
          const positions: typeof drag = {};
          for (const c of changes)
            if (c.type === "position" && c.position)
              positions[c.id] = c.position;
          if (Object.keys(positions).length) {
            if (gesture.current) {
              dragRef.current = { ...dragRef.current, ...positions };
              setDrag(dragRef.current);
            } else {
              // Arrow-key movement is one edit and never changes viewport state.
              onEdit({
                ...doc,
                nodes: doc.nodes.map((n) =>
                  positions[n.id] ? { ...n, position: positions[n.id] } : n,
                ),
              });
            }
          }
        }}
        onNodeClick={(event, n) => {
          if ((event.target as Element).closest(".react-flow__handle,button"))
            return;
          onSelect(n.id);
          if (window.matchMedia("(pointer: coarse)").matches) onInspect(n.id);
        }}
        onNodeDoubleClick={(_, n) => onInspect(n.id)}
        isValidConnection={(c) => {
          const reason = connectionError(doc, edgeFor(c));
          invalid.current = reason ?? "";
          return !reason;
        }}
        onConnect={(c) => {
          if (cancelling.current) return;
          const e = edgeFor(c),
            reason = connectionError(doc, e);
          if (reason) onError(reason);
          else
            onEdit({
              ...doc,
              edges: [...doc.edges, { ...e, id: crypto.randomUUID() }],
            });
        }}
        onClickConnectEnd={() => {
          if (invalid.current) onError(invalid.current);
          invalid.current = "";
        }}
        onConnectEnd={() => {
          if (invalid.current) onError(invalid.current);
          invalid.current = "";
        }}
        ariaLabelConfig={{
          "node.a11yDescription.default":
            "矢印キーで移動、設定ボタンで詳細を開きます",
          "node.a11yDescription.keyboardDisabled":
            "EnterまたはSpaceでノードを選択します",
          "node.a11yDescription.ariaLiveMessage": ({ x, y }) =>
            `ノードを移動しました。横 ${Math.round(x)}、縦 ${Math.round(y)}`,
          "edge.a11yDescription.default":
            "接続の解除はノード詳細設定の接続一覧から操作できます",
          "handle.ariaLabel": "接続端子",
          "controls.zoomIn.ariaLabel": "拡大",
          "controls.zoomOut.ariaLabel": "縮小",
        }}
      >
        <Background gap={24} />
      </ReactFlow>
    </div>
  );
}
