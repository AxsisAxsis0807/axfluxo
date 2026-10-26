import { sha256 } from "../assets";
import type { Snapshot, Value, Graph } from "../../domain/workflow/execution";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function cacheKey(
  node: Graph["nodes"][number],
  inputs: Record<string, Value>,
  snapshot: Snapshot,
) {
  return sha256(
    new Blob([
      canonical({
        type: node.type,
        typeVersion: node.typeVersion,
        config: node.config,
        inputs,
        source: snapshot.sources[node.id] ?? null,
        revision: snapshot.revisions[node.id] ?? null,
        renderer: snapshot.rendererVersion,
        fonts: snapshot.fontVersion,
        output: snapshot.outputSpec,
      }),
    ]),
  );
}
