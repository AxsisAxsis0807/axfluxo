import { imageValue } from "./asset-resolver";
import { pinReferences } from "../library/repository";
import { parseWorkspace } from "../../domain/workspace/schema";
import { parseWorkflow } from "../../domain/workflow/connections";
import {
  ExecutionError,
  safeError,
  terminal,
  type Graph,
  type Snapshot,
  type Run,
  type RunRepository,
  type Resolver,
  type Attempt,
  type Value,
  type NodeContext,
} from "../../domain/workflow/execution";
import { definition, type Registry } from "./registry";
import { cacheKey } from "./cache";
import { loadRevision } from "../workspace/repository";
export function validateGraph(
  raw: unknown,
  registry: Registry,
): { graph: Graph; order: string[] } {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    throw new ExecutionError(
      "GRAPH_INVALID",
      "Workflowは有効なJSONで指定してください",
    );
  }
  if (serialized === undefined)
    throw new ExecutionError(
      "GRAPH_INVALID",
      "Workflowは有効なJSONで指定してください",
    );
  if (new Blob([serialized]).size > 5 * 1024 * 1024)
    throw new ExecutionError("GRAPH_LIMIT", "Workflowが大きすぎます");
  let graph: Graph;
  try {
    graph =
      (raw as { schemaVersion?: number })?.schemaVersion === 1
        ? parseWorkflow(raw)
        : parseWorkspace(raw);
  } catch {
    throw new ExecutionError(
      "GRAPH_INVALID",
      "Workflowの型・version・接続・設定が不正です",
    );
  }
  if (!graph.nodes.length)
    throw new ExecutionError("GRAPH_EMPTY", "実行するノードがありません");
  for (const node of graph.nodes) {
    const def = definition(registry, node);
    def.validate?.(node);
    const required =
      typeof def.required === "function" ? def.required(node) : def.required;
    for (const port of required)
      if (
        !graph.edges.some(
          (edge) => edge.targetNodeId === node.id && edge.targetPortId === port,
        )
      )
        throw new ExecutionError(
          "INPUT_REQUIRED",
          "必須入力が接続されていません",
          node.id,
        );
    if (
      node.type === "source" &&
      !("assetId" in node.config && node.config.assetId) &&
      !("libraryRef" in node.config && node.config.libraryRef)
    )
      throw new ExecutionError(
        "ASSET_REQUIRED",
        "入力素材を選択してください",
        node.id,
      );
    if (
      node.type === "image-edit" &&
      (!node.config.inputMode ||
        !node.config.appliedRevisionId ||
        !node.config.outputPageId)
    )
      throw new ExecutionError(
        "EDIT_REQUIRED",
        "画像編集を適用し、出力ページを選択してください",
        node.id,
      );
  }
  // Stable Kahn order: IDs provide a total ordering independent of edge insertion.
  const degrees = new Map(
    graph.nodes.map((node) => [
      node.id,
      graph.edges.filter((e) => e.targetNodeId === node.id).length,
    ]),
  );
  const ready = graph.nodes
      .filter((node) => degrees.get(node.id) === 0)
      .map((node) => node.id)
      .sort(),
    order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const edge of graph.edges.filter((e) => e.sourceNodeId === id)) {
      const degree = degrees.get(edge.targetNodeId)! - 1;
      degrees.set(edge.targetNodeId, degree);
      if (degree === 0) {
        ready.push(edge.targetNodeId);
        ready.sort();
      }
    }
  }
  if (order.length !== graph.nodes.length)
    throw new ExecutionError("GRAPH_CYCLE", "循環するWorkflowは実行できません");
  return { graph, order };
}
export async function prepareSnapshot(
  raw: unknown,
  registry: Registry,
  resolver: Resolver,
  versions: { rendererVersion: string; fontVersion: string },
  signal: AbortSignal,
): Promise<Snapshot> {
  const { graph } = validateGraph(structuredClone(raw), registry);
  const snapshot: Snapshot = {
    graph,
    sources: Object.create(null),
    revisions: Object.create(null),
    ...versions,
    outputSpec: "png-v1",
  };
  for (const node of graph.nodes) {
    signal.throwIfAborted();
    if (
      node.type === "source" &&
      "libraryRef" in node.config &&
      node.config.libraryRef
    ) {
      const ref = node.config.libraryRef;
      snapshot.sources[node.id] = imageValue(
        ref,
        await resolver.resolve(ref, signal),
      );
    } else if (node.type === "source" && "assetId" in node.config)
      snapshot.sources[node.id] = await resolver.pin(
        node.config.assetId!,
        graph.schemaVersion === 1 ? "legacy" : "workspace",
      );
    if (node.type === "image-edit") {
      const revision = await loadRevision(node.config.appliedRevisionId!);
      if (
        revision.editorDocumentId !== node.config.editorDocumentId ||
        !revision.document.pages.some((p) => p.id === node.config.outputPageId)
      )
        throw new ExecutionError(
          "EDIT_REVISION",
          "適用版と出力ページが一致しません",
          node.id,
        );
      if (
        node.config.inputMode === "selected" &&
        (!revision.input ||
          revision.input.reference.hash !== node.config.selectedAssetRef?.hash)
      )
        throw new ExecutionError(
          "EDIT_INPUT_CHANGED",
          "選択素材と適用版が一致しません",
          node.id,
        );
      snapshot.revisions[node.id] = revision.id;
    }
  }
  signal.throwIfAborted();
  return snapshot;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
const date = () => new Date().toISOString();
export class Runner {
  constructor(
    private registry: Registry,
    private repository: RunRepository,
    private resolver: Resolver,
  ) {}
  async run(
    snapshot: Snapshot,
    options: {
      signal: AbortSignal;
      policy?: "stop" | "continue";
      onChange?: (run: Run) => void;
      retryOf?: string;
    },
  ): Promise<Run> {
    const { order } = validateGraph(snapshot.graph, this.registry);
    const fixed = freeze(structuredClone(snapshot));
    // The host serializes runs. Clamp against durable history so same-tick or
    // backwards wall clocks cannot make a retry look older than its ancestor.
    const [latest] = await this.repository.list(undefined, 1);
    const createdAt = new Date(
      Math.max(Date.now(), latest ? Date.parse(latest.createdAt) + 1 : 0),
    ).toISOString();
    const run: Run = {
      id: crypto.randomUUID(),
      workflowId: fixed.graph.workflowId,
      snapshot: fixed,
      policy: options.policy ?? "stop",
      state: "queued",
      createdAt,
      nodes: Object.fromEntries(
        order.map((nodeId) => [
          nodeId,
          { nodeId, state: "queued", attemptIds: [] },
        ]),
      ),
      retryOf: options.retryOf,
    };
    let rootRunId = run.id;
    if (options.retryOf) {
      const seen = new Set<string>();
      let id: string | undefined = options.retryOf;
      while (id) {
        if (seen.has(id))
          throw new ExecutionError(
            "RETRY_INVALID",
            "再実行履歴が循環しています",
          );
        seen.add(id);
        const previous = (
          await this.repository.list(fixed.graph.workflowId, 100)
        ).find((r) => r.id === id);
        if (!previous)
          throw new ExecutionError(
            "RETRY_MISSING",
            "再実行元の履歴が見つかりません",
          );
        rootRunId = previous.id;
        id = previous.retryOf;
      }
    }
    const refs = Object.values(fixed.sources).flatMap((v) =>
      v.reference.scope === "library" ? [v.reference] : [],
    );
    if (refs.length) await pinReferences(`run:${run.id}`, refs);
    const emit = () => {
      try {
        options.onChange?.(structuredClone(run));
      } catch {
        /* A view must not break durable execution. */
      }
    };
    await this.repository.commit({ run }, options.signal);
    emit();
    run.state = "running";
    await this.repository.commit({ run });
    emit();
    let stopped = false;
    try {
      // Conservative bounded scheduler: one image or lightweight operation at a time.
      for (const nodeId of order) {
        const state = run.nodes[nodeId];
        if (options.signal.aborted) {
          state.state = "cancelled";
          continue;
        }
        const edges = fixed.graph.edges.filter(
          (e) => e.targetNodeId === nodeId,
        );
        if (
          edges.some(
            (edge) => run.nodes[edge.sourceNodeId].state !== "succeeded",
          )
        ) {
          state.state = "blocked";
          continue;
        }
        if (stopped) {
          state.state = "cancelled";
          continue;
        }
        const node = fixed.graph.nodes.find((n) => n.id === nodeId)!,
          def = definition(this.registry, node);
        const inputs: Record<string, Value> = {};
        for (const edge of edges)
          inputs[edge.targetPortId] =
            run.nodes[edge.sourceNodeId].outputs![edge.sourcePortId];
        const previous = options.retryOf
          ? (await this.repository.attempts(options.retryOf)).filter(
              (a) => a.nodeId === nodeId,
            )
          : [];
        const attempt: Attempt = {
          id: crypto.randomUUID(),
          runId: run.id,
          nodeId,
          number: Math.max(0, ...previous.map((a) => a.number)) + 1,
          state: "running",
          startedAt: date(),
        };
        state.attemptIds.push(attempt.id);
        state.state = "running";
        await this.repository.commit({ run, attempt }, options.signal);
        emit();
        const context: NodeContext = {
          signal: options.signal,
          snapshot: fixed,
          nodeId,
          inputs: freeze(structuredClone(inputs)),
          resolver: this.resolver,
          outputs: [],
          saveIdentity: { rootRunId, runId: run.id, attemptId: attempt.id },
        };
        try {
          const key = await cacheKey(node, inputs, fixed);
          const cached = def.pure
            ? await this.repository.cached(key)
            : undefined;
          let results = cached?.outputs;
          if (results) {
            try {
              for (const value of Object.values(results)) {
                const images =
                  value.type === "image"
                    ? [value]
                    : value.type === "collection<image>"
                      ? value.items
                      : [];
                for (const image of images)
                  await this.resolver.resolve(image.reference, options.signal);
              }
            } catch {
              results = undefined;
            }
          }
          options.signal.throwIfAborted();
          const outputs = results ?? (await def.execute(node, context));
          options.signal.throwIfAborted();
          for (const port of def.ports.filter((p) => p.direction === "output"))
            if (!outputs[port.id] || outputs[port.id].type !== port.type)
              throw new ExecutionError(
                "OUTPUT_TYPE",
                "ノード出力の型が不正です",
                nodeId,
              );
          state.outputs = structuredClone(outputs);
          state.state = "succeeded";
          attempt.state = "succeeded";
          attempt.endedAt = date();
          attempt.cacheHit = !!results;
          await this.repository.commit(
            {
              run,
              attempt,
              cache: def.pure ? { id: key, outputs } : undefined,
              outputs: context.outputs,
            },
            options.signal,
          );
        } catch (error) {
          delete state.outputs;
          const cancelled = options.signal.aborted;
          state.state = attempt.state = cancelled ? "cancelled" : "failed";
          if (!cancelled) {
            state.error = attempt.error = safeError(error, nodeId);
            stopped = run.policy === "stop";
          }
          attempt.endedAt = date();
          await this.repository.commit({ run, attempt });
        } finally {
          context.outputs.length = 0;
        }
        emit();
      }
      run.state = options.signal.aborted
        ? "cancelled"
        : Object.values(run.nodes).some((n) => n.state === "failed")
          ? "failed"
          : "succeeded";
    } catch (error) {
      run.state = options.signal.aborted ? "cancelled" : "interrupted";
      run.error = safeError(error);
      for (const node of Object.values(run.nodes))
        if (!terminal(node.state)) node.state = run.state;
      // Persisting is best effort if quota/storage failed; recovery handles a durable running row.
      for (const attempt of await this.repository.attempts(run.id))
        if (!terminal(attempt.state)) {
          attempt.state = run.state;
          attempt.endedAt = date();
          await this.repository.commit({ run, attempt });
        }
    }
    run.endedAt = date();
    try {
      await this.repository.commit({ run }, options.signal);
    } catch (error) {
      if (!options.signal.aborted) throw error;
      run.state = "cancelled";
      await this.repository.commit({ run });
    }
    // Cancellation may arrive as the final transaction completes. Never emit a
    // late success while the host is still waiting for this run to settle.
    if (options.signal.aborted && run.state !== "cancelled") {
      run.state = "cancelled";
      await this.repository.commit({ run });
    }
    emit();
    return run;
  }
}
