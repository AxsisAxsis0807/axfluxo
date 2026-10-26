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
  for (const run of await runRepository.list(doc.workflowId)) {
    if (
      run.state === "cancelled" ||
      run.state === "interrupted" ||
      graphIdentity(run.snapshot.graph, nodeId) !== identity
    )
      continue;
    const node = run.nodes[nodeId];
    if (node?.state !== "succeeded") continue;
    const value = node.outputs?.[portId];
    if (value?.type !== "image") continue;
    signal.throwIfAborted();
    if (value.reference.scope === "workspace") {
      await getAsset(value.reference.reference);
      return value.reference.reference;
    }
    if (value.reference.scope !== "execution")
      throw new ExecutionError(
        "EDIT_INPUT_TYPE",
        "この参照を既存の画像編集へ取り込めません",
      );
    const output = await createAssetResolver().resolve(value.reference, signal);
    let asset = await read<WorkspaceAsset | undefined>("assets", output.id);
    if (!asset) {
      asset = await prepareAsset({
        id: output.id,
        name: "Workflow result",
        blob: output.blob,
        original: output.blob,
        mime: output.mime,
        hash: output.hash,
        width: output.width,
        height: output.height,
      });
      signal.throwIfAborted();
      await write(["assets"], (tx, fail) => {
        const request = tx.objectStore("assets").get(output.id);
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
    const ref = { assetId: asset.id, hash: output.hash };
    await getAsset(ref);
    signal.throwIfAborted();
    return ref;
  }
  return undefined;
}
