import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newNode } from "../src/domain/workflow/schema";
import { newWorkspace } from "../src/services/workspace/repository";
import { newExecutionNode } from "../src/domain/workflow/execution-schema";
import { parseWorkspace } from "../src/domain/workspace/schema";
import { parseWorkflow } from "../src/domain/workflow/connections";
import {
  type ImageValue,
  type Resolver,
  type Graph,
  type Snapshot,
} from "../src/domain/workflow/execution";
import { createRegistry } from "../src/services/workflow/registry";
import {
  Runner,
  prepareSnapshot,
  validateGraph,
} from "../src/services/workflow/runner";
import {
  runRepository as repository,
  openRunDB,
  recoverRunsUnderLock,
} from "../src/services/workflow/run-repository";
import { cacheKey } from "../src/services/workflow/cache";
const signal = () => new AbortController().signal;
const image: ImageValue = {
  type: "image",
  reference: {
    scope: "workspace",
    kind: "image",
    reference: { assetId: crypto.randomUUID(), hash: "a".repeat(64) },
  },
  hash: "a".repeat(64),
  mime: "image/png",
  width: 64,
  height: 64,
  size: 100,
};
const resolver: Resolver = {
  pin: async () => structuredClone(image),
  resolve: async () => ({
    id: "input",
    hash: image.hash,
    blob: new Blob(["image"], { type: "image/png" }),
    mime: "image/png",
    width: 64,
    height: 64,
  }),
};
const versions = { rendererVersion: "test-1", fontVersion: "fonts-1" };
const edge = (
  a: { id: string },
  b: { id: string },
  targetPortId = "in",
  sourcePortId = "out",
) => ({
  id: crypto.randomUUID(),
  sourceNodeId: a.id,
  sourcePortId,
  targetNodeId: b.id,
  targetPortId,
});
function fixture() {
  const source = {
      ...newNode("source"),
      id: "a",
      config: {
        assetId:
          image.reference.scope === "workspace"
            ? image.reference.reference.assetId
            : "input",
      },
    },
    left = { ...newNode("image"), id: "b" },
    right = { ...newNode("image"), id: "c" },
    pack = newExecutionNode("collection-pack"),
    item = newExecutionNode("collection-item");
  const graph = {
    ...newWorkspace(),
    nodes: [source, left, right, pack, item],
    edges: [
      edge(source, left, "in", "image"),
      edge(source, right, "in", "image"),
      edge(left, pack, "first"),
      edge(right, pack, "second"),
      edge(pack, item),
    ],
  };
  return { graph, source, left, right, pack, item };
}
function registry() {
  const registry = new Map(createRegistry());
  const original = registry.get("image@1")!;
  registry.set("image@1", {
    ...original,
    execute: async (_node, context) => ({ out: context.inputs.in }),
  });
  return registry;
}
const prepare = (
  graph: Graph,
  catalog: ReturnType<typeof createRegistry> = registry(),
) => prepareSnapshot(graph, catalog, resolver, versions, signal());
beforeEach(() => repository.evictCache());
afterEach(() => vi.restoreAllMocks());
it("T07: deterministic diamond, shared immutable version, collection port order and rerun attempts", async () => {
  const f = fixture(),
    catalog = registry(),
    snapshot = await prepare(f.graph, catalog);
  expect(
    validateGraph(
      {
        ...f.graph,
        nodes: [...f.graph.nodes].reverse(),
        edges: [...f.graph.edges].reverse(),
      },
      catalog,
    ).order,
  ).toEqual(validateGraph(f.graph, catalog).order);
  const runner = new Runner(catalog, repository, resolver),
    run = await runner.run(snapshot, { signal: signal() });
  expect(run.state).toBe("succeeded");
  expect(run.nodes[f.left.id].outputs?.out).toEqual(
    run.nodes[f.right.id].outputs?.out,
  );
  expect(run.nodes[f.pack.id].outputs?.out).toEqual({
    type: "collection<image>",
    items: [image, image],
  });
  expect(run.nodes[f.item.id].outputs?.out).toEqual(image);
  const again = await runner.run(snapshot, {
    signal: signal(),
    retryOf: run.id,
  });
  expect(again.id).not.toBe(run.id);
  expect(
    (await repository.attempts(again.id)).every(
      (a) => a.number === 2 && a.cacheHit,
    ),
  ).toBe(true);
  expect((await repository.list(f.graph.workflowId)).length).toBe(2);
});
it("T07: collection order and index use stable explicit positions, without modifying inputs", async () => {
  const catalog = registry(),
    order = newExecutionNode("collection-order"),
    item = newExecutionNode("collection-item");
  const second = { ...image, hash: "b".repeat(64) };
  order.config = { reverse: true };
  const context = {
    inputs: {
      in: { type: "collection<image>" as const, items: [image, second] },
    },
    signal: signal(),
    snapshot: {} as Snapshot,
    nodeId: order.id,
    outputs: [],
    resolver,
  };
  const reversed = await catalog
    .get("collection-order@1")!
    .execute(order, context);
  expect(reversed.out).toEqual({
    type: "collection<image>",
    items: [second, image],
  });
  expect(context.inputs.in.items).toEqual([image, second]);
  const selected = await catalog
    .get("collection-item@1")!
    .execute(item, { ...context, inputs: { in: reversed.out } });
  expect(selected.out).toEqual(second);
  item.config = { index: 2 };
  await expect(
    catalog.get("collection-item@1")!.execute(item, context),
  ).rejects.toMatchObject({ code: "COLLECTION_INDEX" });
});
it("T08: rejects corrupt JSON values, unknown node/version, excessive graphs, cycles, type/cardinality and missing inputs", () => {
  const f = fixture(),
    catalog = registry();
  for (const value of [
    "{broken",
    null,
    { ...f.graph, schemaVersion: 99 },
    { ...f.graph, nodes: [{ ...f.source, type: "script" }] },
    { ...f.graph, nodes: [{ ...f.source, typeVersion: 99 }] },
    {
      ...f.graph,
      nodes: Array.from({ length: 201 }, () => ({
        ...f.source,
        id: crypto.randomUUID(),
      })),
    },
    { ...f.graph, edges: [] },
    { ...f.graph, edges: [...f.graph.edges, edge(f.right, f.left)] },
    { ...f.graph, edges: [...f.graph.edges, edge(f.item, f.source, "image")] },
  ])
    expect(() => validateGraph(value, catalog)).toThrow();
  const text = newNode("text");
  expect(() =>
    validateGraph(
      {
        ...newWorkspace(),
        nodes: [text, f.left],
        edges: [edge(text, f.left, "in", "text")],
      },
      catalog,
    ),
  ).toThrow();
});
it.each(["save", "post"] as const)(
  "T08: legacy %s is retained by v1/v2 but preflight is unsupported with no fake success",
  (type) => {
    const node = newNode(type),
      doc = { ...newWorkspace(), nodes: [node] };
    expect(parseWorkspace(doc).nodes[0]).toEqual(node);
    expect(parseWorkflow({ ...doc, schemaVersion: 1 }).nodes[0]).toEqual(node);
    expect(() => validateGraph(doc, registry())).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_NODE", nodeId: node.id }),
    );
  },
);
it.each(["continue", "stop"] as const)(
  "T09: %s distinguishes failed descendants from independent branches",
  async (policy) => {
    const f = fixture(),
      catalog = registry();
    catalog.set("image@1", {
      ...catalog.get("image@1")!,
      execute: async (node, context) => {
        if (node.id === "b") throw new Error("private full text, token, bytes");
        return { out: context.inputs.in };
      },
    });
    const run = await new Runner(catalog, repository, resolver).run(
      await prepare(f.graph, catalog),
      { signal: signal(), policy },
    );
    expect(run.state).toBe("failed");
    expect(run.nodes.b.state).toBe("failed");
    expect(run.nodes.c.state).toBe(
      policy === "continue" ? "succeeded" : "cancelled",
    );
    expect(run.nodes[f.pack.id].state).toBe("blocked");
    expect(run.nodes[f.item.id].state).toBe("blocked");
    expect(run.nodes[f.pack.id].outputs).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain("private full text");
  },
);
it("T10: cancel during unabortable encode drops outputs/cache and starts no more nodes", async () => {
  const f = fixture(),
    catalog = registry(),
    controller = new AbortController(),
    released: string[] = [];
  const outputId = crypto.randomUUID();
  catalog.set("image@1", {
    ...catalog.get("image@1")!,
    execute: async (_node, context) => {
      try {
        controller.abort();
        await Promise.resolve();
        context.outputs.push({
          id: outputId,
          blob: new Blob(["unpublished"]),
          hash: image.hash,
          mime: "image/png",
          width: 64,
          height: 64,
        });
        return { out: image };
      } finally {
        released.push(context.nodeId);
      }
    },
  });
  const snapshot = await prepare(f.graph, catalog);
  const run = await new Runner(catalog, repository, resolver).run(snapshot, {
    signal: controller.signal,
  });
  expect(run.state).toBe("cancelled");
  expect(released).toEqual(["b"]);
  expect(run.nodes.b.outputs).toBeUndefined();
  expect(run.nodes.c.state).toBe("cancelled");
  expect(await repository.output(outputId)).toBeUndefined();
  expect(
    await repository.cached(await cacheKey(f.left, { in: image }, snapshot)),
  ).toBeUndefined();
});
it("T10: transaction cancellation does not publish a partial run or immutable output", async () => {
  const number = newExecutionNode("number"),
    snapshot = await prepare({ ...newWorkspace(), nodes: [number] });
  const run = await new Runner(registry(), repository, resolver).run(snapshot, {
    signal: signal(),
  });
  const controller = new AbortController();
  controller.abort();
  const id = crypto.randomUUID();
  await expect(
    repository.commit(
      {
        run: { ...run, id },
        outputs: [
          {
            id,
            blob: new Blob(["x"]),
            hash: image.hash,
            mime: "image/png",
            width: 64,
            height: 64,
          },
        ],
      },
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  expect((await repository.list()).some((r) => r.id === id)).toBe(false);
  expect(await repository.output(id)).toBeUndefined();
});
it("T10: crash recovery marks run/node/attempt interrupted and never executes again", async () => {
  const number = newExecutionNode("number"),
    snapshot = await prepare({ ...newWorkspace(), nodes: [number] });
  const run = await new Runner(registry(), repository, resolver).run(snapshot, {
    signal: signal(),
  });
  const attempt = (await repository.attempts(run.id))[0];
  run.state = "running";
  run.nodes[number.id].state = "running";
  attempt.state = "running";
  await repository.commit({ run, attempt });
  await recoverRunsUnderLock(repository);
  await recoverRunsUnderLock(repository);
  expect((await repository.list()).find((r) => r.id === run.id)?.state).toBe(
    "interrupted",
  );
  expect((await repository.attempts(run.id))[0].state).toBe("interrupted");
  expect((await repository.attempts(run.id)).length).toBe(1);
});
it("T11: config/input/font/renderer/output specification invalidate cache; property order does not", async () => {
  const f = fixture(),
    snapshot = await prepare(f.graph),
    inputs = { in: image },
    base = await cacheKey(f.left, inputs, snapshot);
  for (const [node, values, fixed] of [
    [
      { ...f.left, config: { operation: "resize", width: 200 } },
      inputs,
      snapshot,
    ],
    [f.left, { in: { ...image, hash: "c".repeat(64) } }, snapshot],
    [f.left, inputs, { ...snapshot, fontVersion: "fonts-2" }],
    [f.left, inputs, { ...snapshot, rendererVersion: "renderer-2" }],
  ] as const)
    expect(await cacheKey(node, values, fixed)).not.toBe(base);
  expect(
    await cacheKey(
      { ...f.left, config: { width: 1080, operation: "resize" } },
      inputs,
      snapshot,
    ),
  ).toBe(base);
});
it("T11: graph edits and event subscribers cannot mutate the persisted execution snapshot", async () => {
  const node = newExecutionNode("number");
  node.config = { value: 3 };
  const graph = { ...newWorkspace(), nodes: [node] },
    snapshot = await prepare(graph);
  const run = await new Runner(registry(), repository, resolver).run(snapshot, {
    signal: signal(),
    onChange: (view) => {
      node.config = { value: 99 };
      snapshot.graph.name = "mutated";
      view.state = "failed";
    },
  });
  expect(run.state).toBe("succeeded");
  expect(run.snapshot.graph.name).not.toBe("mutated");
  expect(run.nodes[node.id].outputs?.number).toEqual({
    type: "number",
    value: 3,
  });
});
it("T11: evicting cache retains outputs pinned by history and removes only unreferenced bytes", async () => {
  const f = fixture(),
    catalog = registry(),
    id = crypto.randomUUID(),
    orphan = crypto.randomUUID();
  const generated = {
    ...image,
    reference: {
      scope: "execution" as const,
      kind: "image" as const,
      outputId: id,
      hash: image.hash,
    },
  };
  catalog.set("image@1", {
    ...catalog.get("image@1")!,
    execute: async () => ({ out: generated }),
  });
  const run = await new Runner(catalog, repository, resolver).run(
    await prepare(f.graph, catalog),
    { signal: signal() },
  );
  await repository.commit({
    run,
    outputs: [id, orphan].map((id) => ({
      id,
      blob: new Blob(["result"]),
      hash: image.hash,
      mime: "image/png",
      width: 64,
      height: 64,
    })),
  });
  await repository.evictCache();
  expect(await repository.output(id)).toBeDefined();
  expect(await repository.output(orphan)).toBeUndefined();
});
it("execution DB uses separate stores and closes for version changes", async () => {
  const db = await openRunDB();
  expect([...db.objectStoreNames].sort()).toEqual([
    "attempts",
    "cache",
    "outputs",
    "runs",
  ]);
  const close = vi.spyOn(db, "close");
  db.dispatchEvent(new IDBVersionChangeEvent("versionchange"));
  expect(close).toHaveBeenCalledOnce();
});

it("T10: cancellation racing with final run persistence cannot emit late success", async () => {
  const node = newExecutionNode("number"),
    graph = { ...newWorkspace(), nodes: [node] },
    snapshot = await prepare(graph),
    controller = new AbortController();
  const emitted: string[] = [];
  const wrapped = {
    ...repository,
    commit: async (
      change: Parameters<typeof repository.commit>[0],
      signal?: AbortSignal,
    ) => {
      if (change.run.state === "succeeded" && !change.attempt)
        controller.abort();
      await repository.commit(change, signal);
    },
  };
  const run = await new Runner(registry(), wrapped, resolver).run(snapshot, {
    signal: controller.signal,
    onChange: (run) => emitted.push(run.state),
  });
  expect(run.state).toBe("cancelled");
  expect(emitted).not.toContain("succeeded");
  expect((await repository.list(run.workflowId))[0].state).toBe("cancelled");
});

it("preflight rejects supported configs exceeding output allocation limits without changing legacy documents", () => {
  const source = newNode("source"),
    large = newNode("image"),
    explicit = newExecutionNode("image-resize");
  source.config = { assetId: crypto.randomUUID() };
  large.config = { operation: "crop", width: 8192 };
  explicit.config = { width: 4096, height: 4096 };
  for (const node of [large, explicit]) {
    const graph = {
      ...newWorkspace(),
      nodes: [source, node],
      edges: [edge(source, node, "in", "image")],
    };
    expect(parseWorkspace(graph)).toEqual(graph);
    expect(() => validateGraph(graph, createRegistry())).toThrowError(
      expect.objectContaining({ code: "OUTPUT_LIMIT", nodeId: node.id }),
    );
  }
});

it("T08: serializability failures use a safe graph validation error", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const raw of [undefined, 1n, cyclic])
    expect(() => validateGraph(raw, createRegistry())).toThrowError(
      expect.objectContaining({ code: "GRAPH_INVALID" }),
    );
});
it("T07: legacy source IDs resembling object prototype keys survive pinned execution and history", async () => {
  const catalog = registry(),
    source = newNode("source");
  source.id = "__proto__";
  source.config = { assetId: crypto.randomUUID() };
  const snapshot = await prepare(
    { ...newWorkspace(), nodes: [source] },
    catalog,
  );
  expect(Object.hasOwn(snapshot.sources, source.id)).toBe(true);
  const run = await new Runner(catalog, repository, resolver).run(snapshot, {
    signal: signal(),
  });
  expect(run.state).toBe("succeeded");
  expect(run.nodes[source.id].outputs?.image).toEqual(image);
  expect(
    (await repository.list(run.workflowId))[0].nodes[source.id].outputs?.image,
  ).toEqual(image);
});
it("T11: number cache preserves negative zero instead of reusing positive zero", async () => {
  const node = newExecutionNode("number"),
    graph = { ...newWorkspace(), nodes: [node] },
    catalog = createRegistry();
  const positive = await prepare(graph, catalog),
    runner = new Runner(catalog, repository, resolver);
  await runner.run(positive, { signal: signal() });
  node.config = { value: -0 };
  const negative = await prepare(graph, catalog);
  expect(await cacheKey(node, {}, negative)).not.toBe(
    await cacheKey(positive.graph.nodes[0], {}, positive),
  );
  const run = await runner.run(negative, { signal: signal() });
  expect(run.nodes[node.id].outputs?.number).toEqual({
    type: "number",
    value: -0,
  });
});

it("T08: graph byte limits count UTF-8 rather than JavaScript characters", () => {
  const text = newNode("text");
  text.config = { text: "あ".repeat(10000) };
  const graph = {
    ...newWorkspace(),
    nodes: Array.from({ length: 180 }, () => ({
      ...text,
      id: crypto.randomUUID(),
    })),
  };
  expect(JSON.stringify(graph).length).toBeLessThan(5 * 1024 * 1024);
  expect(new Blob([JSON.stringify(graph)]).size).toBeGreaterThan(
    5 * 1024 * 1024,
  );
  expect(() => validateGraph(graph, createRegistry())).toThrowError(
    expect.objectContaining({ code: "GRAPH_LIMIT" }),
  );
});

it("T11: run ordering remains newest-first when the wall clock repeats or moves backwards", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-10-26T00:00:00.000Z"));
    const node = newExecutionNode("number"),
      graph = { ...newWorkspace(), nodes: [node] },
      snapshot = await prepare(graph),
      runner = new Runner(registry(), repository, resolver);
    const first = await runner.run(snapshot, { signal: signal() });
    const second = await runner.run(snapshot, { signal: signal() });
    vi.setSystemTime(new Date("2026-10-25T23:00:00.000Z"));
    const third = await runner.run(snapshot, { signal: signal() });
    expect(Date.parse(second.createdAt)).toBeGreaterThan(
      Date.parse(first.createdAt),
    );
    expect(Date.parse(third.createdAt)).toBeGreaterThan(
      Date.parse(second.createdAt),
    );
    expect(
      (await repository.list(graph.workflowId)).map((run) => run.id),
    ).toEqual([third.id, second.id, first.id]);
  } finally {
    vi.useRealTimers();
  }
});
