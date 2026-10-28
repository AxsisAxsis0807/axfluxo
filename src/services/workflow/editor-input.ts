import type {
  WorkspaceDocument,
  AssetRef,
} from "../../domain/workspace/schema";
import { ExecutionError, type Graph } from "../../domain/workflow/execution";
import { read, write } from "../workspace/db";
import {
  prepareAsset,
  getAsset,
  type WorkspaceAsset,
} from "../workspace/repository";
import { runRepository } from "./run-repository";
import { createAssetResolver } from "./asset-resolver";
import { canonical } from "./cache";
import type { Reference } from "../../domain/workflow/execution";
import { sha256 } from "../assets";
/** Layout, save CAS and names do not invalidate a computational input. */
export function graphIdentity(graph: Graph, targetId?: string) {
  const included = new Set<string>();
  const pending = targetId ? [targetId] : graph.nodes.map((node) => node.id);
  while (pending.length) {
    const id = pending.pop()!;
    if (included.has(id)) continue;
    included.add(id);
    pending.push(
      ...graph.edges
        .filter((edge) => edge.targetNodeId === id)
        .map((edge) => edge.sourceNodeId),
    );
  }

  return canonical({
    schemaVersion: graph.schemaVersion,
    nodes: graph.nodes
      .filter((node) => included.has(node.id))
      .map(({ id, type, typeVersion, config }) => ({
        id,
        type,
        typeVersion,
        config,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: graph.edges
      .filter((edge) => included.has(edge.targetNodeId))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  });
}
/** Explicit adapter into the unchanged v2 editor AssetRef/backup contract.
 * Only a consumed output is copied. No graph mutation or mutable latest pointer. */
export async function executionEditorInput(
  doc: WorkspaceDocument,
  nodeId: string,
  portId: string,
  signal: AbortSignal,
): Promise<AssetRef | undefined> {
  const identity = graphIdentity(doc, nodeId);
  const runs = await runRepository.list(doc.workflowId);
  for (const [index, run] of runs.entries()) {
    if (graphIdentity(run.snapshot.graph, nodeId) !== identity) continue;
    // Old records can have identical timestamps; UUID order is not chronology.
    if (
      runs
        .slice(index + 1)
        .some(
          (other) =>
            other.createdAt === run.createdAt &&
            graphIdentity(other.snapshot.graph, nodeId) === identity,
        )
    )
      return undefined;
    // The newest matching run is authoritative. A retry must never revive an
    // older descendant output while this run is pending, blocked or failed.
    if (run.state === "cancelled" || run.state === "interrupted")
      return undefined;
    const node = run.nodes[nodeId];
    if (node?.state !== "succeeded") return undefined;
    const value = node.outputs?.[portId];
    if (value?.type !== "image") return undefined;
    signal.throwIfAborted();
    return pinEditorInput(value.reference, signal);
  }
  return undefined;
}

/** Bridge a consumed immutable image into the unchanged editor/backup AssetRef.
 * Library keys are not necessarily UUIDs; keep their complete identity in the key. */
export async function pinEditorInput(
  reference: Reference,
  signal: AbortSignal,
): Promise<AssetRef> {
  signal.throwIfAborted();
  if (reference.scope === "workspace") {
    await getAsset(reference.reference);
    signal.throwIfAborted();
    return reference.reference;
  }
  if (reference.scope !== "execution" && reference.scope !== "library")
    throw new ExecutionError(
      "EDIT_INPUT_TYPE",
      "この参照を画像編集へ取り込めません",
    );
  const output = await createAssetResolver().resolve(reference, signal);
  const key = await sha256(new Blob([canonical(reference)]));
  const id =
    reference.scope === "execution"
      ? output.id
      : `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
  signal.throwIfAborted();
  let asset = await read<WorkspaceAsset | undefined>("assets", id);
  if (!asset) {
    asset = await prepareAsset({
      id,
      name: "Workflow input",
      blob: output.blob,
      original: output.blob,
      mime: output.mime,
      hash: output.hash,
      width: output.width,
      height: output.height,
    });
    signal.throwIfAborted();
    await write(["assets"], (tx, fail) => {
      const abort = () =>
        fail(new DOMException("入力取り込みを中断しました", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      const detach = () => signal.removeEventListener("abort", abort);
      tx.addEventListener("complete", detach, { once: true });
      tx.addEventListener("abort", detach, { once: true });
      const request = tx.objectStore("assets").get(id);
      request.onsuccess = () => {
        try {
          signal.throwIfAborted();
          if (!request.result) tx.objectStore("assets").add(asset);
          else if (request.result.hash !== output.hash)
            fail(new Error("immutable collision"));
        } catch (error) {
          fail(error);
        }
      };
    });
  }
  const ref = { assetId: id, hash: output.hash };
  await getAsset(ref);
  signal.throwIfAborted();
  return ref;
}

/** Run only the connected input's ancestors before an editor has an applied revision.
 * Keep workflow/ancestor IDs so normal execution-result authority and cache apply. */
export function editorUpstreamGraph(graph: Graph, editorId: string): Graph {
  if (graph.schemaVersion !== 2)
    throw new ExecutionError(
      "EDIT_TARGET",
      "Workspaceの画像編集を選択してください",
    );
  const editor = graph.nodes.find((node) => node.id === editorId);
  if (editor?.type !== "image-edit" || editor.config.inputMode !== "connected")
    throw new ExecutionError(
      "EDIT_TARGET",
      "接続入力の画像編集を選択してください",
    );
  const pending = graph.edges
    .filter(
      (edge) => edge.targetNodeId === editorId && edge.targetPortId === "in",
    )
    .map((edge) => edge.sourceNodeId);
  if (!pending.length)
    throw new ExecutionError("INPUT_REQUIRED", "元画像を接続してください");
  const included = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (included.has(id)) continue;
    included.add(id);
    pending.push(
      ...graph.edges
        .filter((edge) => edge.targetNodeId === id)
        .map((edge) => edge.sourceNodeId),
    );
  }
  return structuredClone({
    ...graph,
    nodes: graph.nodes.filter((node) => included.has(node.id)),
    edges: graph.edges.filter(
      (edge) =>
        included.has(edge.sourceNodeId) && included.has(edge.targetNodeId),
    ),
  });
}
