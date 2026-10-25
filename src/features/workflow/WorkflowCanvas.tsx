"use client";
/* eslint-disable @next/next/no-img-element -- local output thumbnail URLs are owned by the workspace */
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
  type WorkflowEdge,
  type Port,
  type Viewport,
} from "../../domain/workflow/schema";
import { connectionError } from "../../domain/workflow/connections";
import { pinchViewport, type Point } from "../../domain/workflow/viewport";
export type FlowNode = Node<
  {
    node: { id: string; type: string };
    definition: { label: string; ports: Port[] };
    title?: string;
    status?: string;
    thumbnail?: string;
    inspect: (id: string) => void;
  },
  "workflow"
>;
function WorkflowCard({ data }: NodeProps<FlowNode>) {
  const definition = data.definition;
  return (
    <article className="wf-node">
      <header className="wf-drag">
        <b>{data.title ?? definition.label}</b>
        <span>{data.status ?? "設定のみ"}</span>
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
      {data.thumbnail && (
        <img
          className="wf-thumbnail"
          src={data.thumbnail}
          alt="出力サムネイル"
        />
      )}
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
type Graph = {
  nodes: { id: string; type: string; position: { x: number; y: number } }[];
  edges: WorkflowEdge[];
};
export default function WorkflowCanvas<T extends Graph>({
  document: doc,
  viewport,
  selected,
  onEdit,
  onViewport,
  onInspect,
  onSelect,
  onError,
  onInit,
  nodeDefinitions = definitions,
  nodeStatus,
  nodeTitles,
  thumbnails,
}: {
  document: T;
  viewport: Viewport;
  nodeDefinitions?: Record<string, { label: string; ports: Port[] }>;
  nodeStatus?: Record<string, string>;
  nodeTitles?: Record<string, string>;
  thumbnails?: Record<string, string>;
  selected?: string;
  onEdit: (d: T) => void;
  onViewport: (v: Viewport) => void;
  onInspect: (id: string) => void;
  onSelect: (id: string) => void;
  onError: (s: string) => void;
  onInit: (instance: ReactFlowInstance<FlowNode>) => void;
}) {
  const canvasRoot = useRef<HTMLDivElement>(null);
  const cancelling = useRef(false);
  // React Flow's measured dimensions belong to the adapter, not the document.
  // Dropping them on a parent re-render hides a node just as selection starts.
  const [measured, setMeasured] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const touchGesture = useRef<{
    viewport: Viewport;
    points: Point[];
    suspended?: boolean;
  } | null>(null);
  const liveViewport = useRef(viewport);
  liveViewport.current = viewport;
  function touchPoints(touches: React.TouchList): Point[] {
    const bounds = canvasRoot.current!.getBoundingClientRect();
    return Array.from(touches)
      .slice(0, 2)
      .map((t) => ({ x: t.clientX - bounds.left, y: t.clientY - bounds.top }));
  }
  function moveTouchViewport(next: Viewport) {
    liveViewport.current = next;
    onViewport(next);
  }
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
    measured: measured[n.id],
    selected: n.id === selected,
    ariaLabel: nodeTitles?.[n.id] ?? nodeDefinitions[n.type].label,
    data: {
      node: n,
      definition: nodeDefinitions[n.type],
      title: nodeTitles?.[n.id],
      status: nodeStatus?.[n.id],
      thumbnail: thumbnails?.[n.id],
      inspect: onInspect,
    },
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
    if (touchGesture.current) touchGesture.current.suspended = true;
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
      ref={canvasRoot}
      aria-label="Workflowキャンバス"
      onPointerDownCapture={(e) => {
        pointers.current.add(e.pointerId);
        if (pointers.current.size > 1) finishDrag();
      }}
      onPointerUpCapture={(e) => {
        pointers.current.delete(e.pointerId);
      }}
      onTouchStartCapture={(e) => {
        const overNode = Array.from(e.touches).some((t) =>
          (t.target as Element).closest?.(".react-flow__node"),
        );
        if (e.touches.length === 2 && (overNode || touchGesture.current)) {
          cancelGesture();
          touchGesture.current = {
            viewport: liveViewport.current,
            points: touchPoints(e.touches),
          };
          e.stopPropagation();
        }
      }}
      onTouchMoveCapture={(e) => {
        const gesture = touchGesture.current;
        if (!gesture) return;
        e.stopPropagation();
        if (gesture.suspended) return;
        const points = touchPoints(e.touches);
        if (points.length === 2 && gesture.points.length === 2) {
          moveTouchViewport(
            pinchViewport(
              gesture.viewport,
              gesture.points as [Point, Point],
              points as [Point, Point],
            ),
          );
        } else if (points.length === 1 && gesture.points.length === 1) {
          moveTouchViewport({
            ...gesture.viewport,
            x: gesture.viewport.x + points[0].x - gesture.points[0].x,
            y: gesture.viewport.y + points[0].y - gesture.points[0].y,
          });
        }
      }}
      onTouchEndCapture={(e) => {
        if (!touchGesture.current) return;
        // Let D3 receive the native end event to release its first-finger drag.
        touchGesture.current = e.touches.length
          ? {
              viewport: liveViewport.current,
              points: touchPoints(e.touches),
              suspended: touchGesture.current.suspended,
            }
          : null;
      }}
      onTouchCancelCapture={() => {
        touchGesture.current = null;
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
          for (const c of changes) {
            if (c.type === "dimensions" && c.dimensions) {
              const size = c.dimensions;
              setMeasured((previous) =>
                previous[c.id]?.width === size.width &&
                previous[c.id]?.height === size.height
                  ? previous
                  : { ...previous, [c.id]: size },
              );
            }
          }
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
          const reason = connectionError(doc, edgeFor(c), nodeDefinitions);
          invalid.current = reason ?? "";
          return !reason;
        }}
        onConnect={(c) => {
          if (cancelling.current) return;
          const e = edgeFor(c),
            reason = connectionError(doc, e, nodeDefinitions);
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
