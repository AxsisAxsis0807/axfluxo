import {
  definitions,
  workflowSchema,
  type WorkflowDocument,
  type WorkflowEdge,
  type PortType,
} from "./schema";
export const compatible = (a: PortType, b: PortType) => a === b;
export function connectionError(
  d: WorkflowDocument,
  e: Omit<WorkflowEdge, "id">,
): string | null {
  const s = d.nodes.find((n) => n.id === e.sourceNodeId),
    t = d.nodes.find((n) => n.id === e.targetNodeId);
  if (!s || !t) return "ノードが存在しません";
  if (s.id === t.id) return "自己接続はできません";
  const out = definitions[s.type].ports.find((p) => p.id === e.sourcePortId),
    input = definitions[t.type].ports.find((p) => p.id === e.targetPortId);
  if (!out || !input) return "端子が存在しません";
  if (out.direction !== "output" || input.direction !== "input")
    return "出力から入力へ接続してください";
  if (!compatible(out.type, input.type))
    return `型が一致しません（${out.type} → ${input.type}）`;
  if (
    d.edges.some(
      (x) =>
        x.sourceNodeId === e.sourceNodeId &&
        x.sourcePortId === e.sourcePortId &&
        x.targetNodeId === e.targetNodeId &&
        x.targetPortId === e.targetPortId,
    )
  )
    return "同じ接続が既に存在します";
  if (
    d.edges.some(
      (x) =>
        x.targetNodeId === e.targetNodeId && x.targetPortId === e.targetPortId,
    )
  )
    return "この入力は既に接続されています";
  const pending = [e.targetNodeId],
    seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === e.sourceNodeId) return "循環する接続はできません";
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(
      ...d.edges
        .filter((x) => x.sourceNodeId === id)
        .map((x) => x.targetNodeId),
    );
  }
  return null;
}
export function parseWorkflow(value: unknown): WorkflowDocument {
  const d = workflowSchema.parse(value);
  const accepted: WorkflowDocument = { ...d, edges: [] };
  for (const edge of d.edges) {
    const error = connectionError(accepted, edge);
    if (error) throw new Error(error);
    accepted.edges.push(edge);
  }
  return d;
}
