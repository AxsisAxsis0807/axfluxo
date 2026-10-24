import dagre from "@dagrejs/dagre";
import { WORKFLOW_LIMITS } from "../../config/workflow-limits";
import { parseWorkflow } from "./connections";
import type { WorkflowDocument } from "./schema";
export type History = {
  past: WorkflowDocument[];
  present: WorkflowDocument;
  future: WorkflowDocument[];
};
export function commit(h: History, next: WorkflowDocument): History {
  const d = parseWorkflow(next);
  if (JSON.stringify(h.present) === JSON.stringify(d)) return h;
  return {
    past: [...h.past, h.present].slice(-WORKFLOW_LIMITS.history),
    present: d,
    future: [],
  };
}
export function undo(h: History): History {
  return h.past.length
    ? {
        past: h.past.slice(0, -1),
        present: h.past.at(-1)!,
        future: [h.present, ...h.future],
      }
    : h;
}
export function redo(h: History): History {
  return h.future.length
    ? {
        past: [...h.past, h.present],
        present: h.future[0],
        future: h.future.slice(1),
      }
    : h;
}
export function deleteNode(d: WorkflowDocument, id: string): WorkflowDocument {
  return {
    ...d,
    nodes: d.nodes.filter((n) => n.id !== id),
    edges: d.edges.filter(
      (e) => e.sourceNodeId !== id && e.targetNodeId !== id,
    ),
  };
}
export function duplicateNode(
  d: WorkflowDocument,
  id: string,
): WorkflowDocument {
  const n = d.nodes.find((n) => n.id === id);
  return n
    ? {
        ...d,
        nodes: [
          ...d.nodes,
          {
            ...structuredClone(n),
            id: crypto.randomUUID(),
            position: { x: n.position.x + 40, y: n.position.y + 40 },
          },
        ],
      }
    : d;
}
export function arrange(d: WorkflowDocument): WorkflowDocument {
  const graph = new dagre.graphlib.Graph()
    .setGraph({ rankdir: "LR", nodesep: 60, ranksep: 100 })
    .setDefaultEdgeLabel(() => ({}));
  d.nodes.forEach((n) => graph.setNode(n.id, { width: 240, height: 210 }));
  d.edges.forEach((e) => graph.setEdge(e.sourceNodeId, e.targetNodeId));
  dagre.layout(graph);
  return {
    ...d,
    nodes: d.nodes.map((n) => ({
      ...n,
      position: { x: graph.node(n.id).x - 120, y: graph.node(n.id).y - 105 },
    })),
  };
}
