import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
vi.mock("../src/services/assets", async (original) => ({
  ...(await original<typeof import("../src/services/assets")>()),
  decodeImage: vi.fn(async () => ({ naturalWidth: 1, naturalHeight: 1 })),
}));
import {
  createAssetResolver,
  referenceSchema,
  validateImage,
} from "../src/services/workflow/asset-resolver";
import { sha256 } from "../src/services/assets";
import { put, get, type Asset } from "../src/services/storage";
import { write, read } from "../src/services/workspace/db";
import type {
  LibraryReference,
  Output,
} from "../src/domain/workflow/execution";
import { graphIdentity } from "../src/services/workflow/editor-input";
import { newNode } from "../src/domain/workflow/schema";
import { newWorkspace } from "../src/services/workspace/repository";
async function fixture() {
  const blob = new Blob(
    [
      Uint8Array.from(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII=",
          "base64",
        ),
      ),
    ],
    { type: "image/png" },
  );
  const hash = await sha256(blob),
    asset: Asset = {
      id: crypto.randomUUID(),
      name: "original.png",
      hash,
      blob,
      original: blob,
      mime: "image/png",
      width: 1,
      height: 1,
    };
  return {
    asset,
    output: {
      id: asset.id,
      hash,
      blob,
      mime: "image/png",
      width: 1,
      height: 1,
    } satisfies Output,
  };
}
it("old assetId and v2 AssetRef resolve in their original stores; source bytes remain unchanged across workflows", async () => {
  const { asset } = await fixture();
  await put("assets", asset);
  await write(["assets"], (tx) => {
    tx.objectStore("assets").add(asset);
  });
  const resolver = createAssetResolver();
  const old = await resolver.pin(asset.id, "legacy"),
    workspace = await resolver.pin(asset.id, "workspace");
  expect(old.reference.scope).toBe("legacy");
  expect(workspace.reference.scope).toBe("workspace");
  for (let index = 0; index < 2; index++) {
    expect(
      (await resolver.resolve(old.reference, new AbortController().signal))
        .hash,
    ).toBe(asset.hash);
    expect(
      (
        await resolver.resolve(
          workspace.reference,
          new AbortController().signal,
        )
      ).hash,
    ).toBe(asset.hash);
  }
  expect(await sha256((await get<Asset>("assets", asset.id))!.original)).toBe(
    asset.hash,
  );
  expect(await sha256((await read<Asset>("assets", asset.id)).original)).toBe(
    asset.hash,
  );
  await expect(
    resolver.resolve(
      {
        scope: "workspace",
        kind: "image",
        reference: { assetId: asset.id, hash: "0".repeat(64) },
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "ASSET_HASH" });
});
it("versioned library adapter resolves only exact immutable version, rejects missing versions and file→image", async () => {
  const { output } = await fixture();
  const reference: LibraryReference = {
    scope: "library",
    libraryId: "library",
    fileId: "file",
    versionId: "version-1",
    kind: "image",
    hash: output.hash,
  };
  const lookup = vi.fn(async (ref: LibraryReference) =>
      ref.versionId === "version-1" ? output : undefined,
    ),
    resolver = createAssetResolver(undefined, lookup);
  expect(
    (await resolver.resolve(reference, new AbortController().signal)).hash,
  ).toBe(output.hash);
  await expect(
    resolver.resolve(
      { ...reference, versionId: "version-missing" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "ASSET_MISSING" });
  expect(
    referenceSchema.safeParse({ ...reference, versionId: undefined }).success,
  ).toBe(false);
  lookup.mockClear();
  await expect(
    resolver.resolve(
      { ...reference, kind: "file" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "ASSET_TYPE" });
  expect(lookup).not.toHaveBeenCalled();
});
it("resolver checks bytes hash, MIME, dimensions and allocation limits before decode", async () => {
  const { output } = await fixture();
  for (const value of [
    { ...output, mime: "image/jpeg" },
    { ...output, width: 8193 },
    { ...output, height: 2 },
    { ...output, blob: new Blob(["not png"], { type: "image/png" }) },
    { ...output, hash: "0".repeat(64) },
  ])
    await expect(validateImage(value, output.hash)).rejects.toThrow();
});
it("editor input identity ignores layout/downstream edits but rejects changed ancestors", () => {
  const source = newNode("source"),
    image = newNode("image"),
    text = newNode("text");
  const graph = {
    ...newWorkspace(),
    nodes: [source, image],
    edges: [
      {
        id: crypto.randomUUID(),
        sourceNodeId: source.id,
        sourcePortId: "image",
        targetNodeId: image.id,
        targetPortId: "in",
      },
    ],
  };
  const identity = graphIdentity(graph, image.id),
    moved = structuredClone(graph);
  moved.nodes[0].position.x += 100;
  moved.revision++;
  moved.nodes.push(text);
  expect(graphIdentity(moved, image.id)).toBe(identity);
  moved.nodes[0].config = { assetId: crypto.randomUUID() };
  expect(graphIdentity(moved, image.id)).not.toBe(identity);
});

it("generated output is consumed into the existing editor once, remains hash-fixed and rejects stale ancestors", async () => {
  const { asset, output } = await fixture();
  await write(["assets"], (tx) => {
    tx.objectStore("assets").add(asset);
  });
  const { createRegistry } = await import("../src/services/workflow/registry");
  const { Runner, prepareSnapshot } =
    await import("../src/services/workflow/runner");
  const { runRepository } =
    await import("../src/services/workflow/run-repository");
  const { executionEditorInput } =
    await import("../src/services/workflow/editor-input");
  const { newImageEdit } = await import("../src/services/workspace/repository");
  const { resolveInput } = await import("../src/services/workspace/input");
  const source = newNode("source"),
    processed = newNode("image"),
    editor = newImageEdit().node;
  source.config = { assetId: asset.id };
  editor.config.inputMode = "connected";
  const graph = {
    ...newWorkspace(),
    nodes: [source, processed],
    edges: [
      {
        id: crypto.randomUUID(),
        sourceNodeId: source.id,
        sourcePortId: "image",
        targetNodeId: processed.id,
        targetPortId: "in",
      },
    ],
  };
  const id = crypto.randomUUID(),
    registry = new Map(createRegistry());
  registry.set("image@1", {
    ...registry.get("image@1")!,
    execute: async (_node, context) => {
      context.outputs.push({ ...output, id });
      return {
        out: {
          type: "image",
          reference: {
            scope: "execution",
            kind: "image",
            outputId: id,
            hash: output.hash,
          },
          hash: output.hash,
          mime: output.mime,
          width: 1,
          height: 1,
          size: output.blob.size,
        },
      };
    },
  });
  const resolver = createAssetResolver();
  const snapshot = await prepareSnapshot(
    graph,
    registry,
    resolver,
    { rendererVersion: crypto.randomUUID(), fontVersion: "test" },
    new AbortController().signal,
  );
  expect(
    (
      await new Runner(registry, runRepository, resolver).run(snapshot, {
        signal: new AbortController().signal,
      })
    ).state,
  ).toBe("succeeded");
  const before = (await read<Asset[]>("assets")).length;
  const first = await executionEditorInput(
    graph,
    processed.id,
    "out",
    new AbortController().signal,
  );
  expect(first).toEqual({ assetId: id, hash: output.hash });
  expect(
    await executionEditorInput(
      graph,
      processed.id,
      "out",
      new AbortController().signal,
    ),
  ).toEqual(first);
  expect((await read<Asset[]>("assets")).length).toBe(before + 1);
  const connected = {
    ...graph,
    nodes: [...graph.nodes, editor],
    edges: [
      ...graph.edges,
      {
        id: crypto.randomUUID(),
        sourceNodeId: processed.id,
        sourcePortId: "out",
        targetNodeId: editor.id,
        targetPortId: "in",
      },
    ],
  };
  expect(
    await resolveInput(connected, editor, new AbortController().signal),
  ).toEqual(first);
  processed.config = { operation: "resize", width: 200 };
  expect(
    await executionEditorInput(
      graph,
      processed.id,
      "out",
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(await sha256((await read<Asset>("assets", asset.id)).original)).toBe(
    asset.hash,
  );
});

it.each([
  "failed",
  "blocked",
  "queued",
  "running",
  "cancelled",
  "interrupted",
] as const)(
  "T11: latest matching %s result must not fall back to a previous successful editor input",
  async (state) => {
    const { asset } = await fixture();
    await write(["assets"], (tx) => {
      tx.objectStore("assets").add(asset);
    });
    const { createRegistry } =
      await import("../src/services/workflow/registry");
    const { prepareSnapshot, Runner } =
      await import("../src/services/workflow/runner");
    const { runRepository } =
      await import("../src/services/workflow/run-repository");
    const { executionEditorInput } =
      await import("../src/services/workflow/editor-input");
    const source = newNode("source");
    source.config = { assetId: asset.id };
    const graph = { ...newWorkspace(), nodes: [source] },
      resolver = createAssetResolver(),
      registry = createRegistry();
    const snapshot = await prepareSnapshot(
      graph,
      registry,
      resolver,
      { rendererVersion: "audit", fontVersion: "audit" },
      new AbortController().signal,
    );
    const first = await new Runner(registry, runRepository, resolver).run(
      snapshot,
      { signal: new AbortController().signal },
    );
    expect(
      await executionEditorInput(
        graph,
        source.id,
        "image",
        new AbortController().signal,
      ),
    ).toEqual({ assetId: asset.id, hash: asset.hash });
    const next = structuredClone(first);
    next.id = crypto.randomUUID();
    next.createdAt = new Date(Date.parse(first.createdAt) + 1000).toISOString();
    next.state = state;
    next.nodes[source.id].state = state;
    delete next.nodes[source.id].outputs;
    await runRepository.commit({ run: next });
    expect(
      await executionEditorInput(
        graph,
        source.id,
        "image",
        new AbortController().signal,
      ),
    ).toBeUndefined();
    expect(
      (await runRepository.list(graph.workflowId)).find(
        (run) => run.id === first.id,
      )?.nodes[source.id].outputs,
    ).toBeDefined();
  },
);

it("T11: ambiguous old run timestamps never choose an arbitrary UUID's editor output", async () => {
  const { asset } = await fixture();
  await write(["assets"], (tx) => {
    tx.objectStore("assets").add(asset);
  });
  const { createRegistry } = await import("../src/services/workflow/registry");
  const { prepareSnapshot, Runner } =
    await import("../src/services/workflow/runner");
  const { runRepository } =
    await import("../src/services/workflow/run-repository");
  const { executionEditorInput } =
    await import("../src/services/workflow/editor-input");
  const source = newNode("source");
  source.config = { assetId: asset.id };
  const graph = { ...newWorkspace(), nodes: [source] },
    resolver = createAssetResolver(),
    registry = createRegistry();
  const snapshot = await prepareSnapshot(
    graph,
    registry,
    resolver,
    { rendererVersion: "audit", fontVersion: "audit" },
    new AbortController().signal,
  );
  const run = await new Runner(registry, runRepository, resolver).run(
    snapshot,
    { signal: new AbortController().signal },
  );
  const success = structuredClone(run);
  success.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const failed = structuredClone(run);
  failed.id = "00000000-0000-4000-8000-000000000000";
  failed.state = "failed";
  failed.nodes[source.id].state = "failed";
  delete failed.nodes[source.id].outputs;
  await runRepository.commit({ run: success });
  await runRepository.commit({ run: failed });
  expect(
    await executionEditorInput(
      graph,
      source.id,
      "image",
      new AbortController().signal,
    ),
  ).toBeUndefined();
  const retry = await new Runner(registry, runRepository, resolver).run(
    snapshot,
    { signal: new AbortController().signal },
  );
  expect(Date.parse(retry.createdAt)).toBeGreaterThan(
    Date.parse(run.createdAt),
  );
  expect(
    await executionEditorInput(
      graph,
      source.id,
      "image",
      new AbortController().signal,
    ),
  ).toEqual({ assetId: asset.id, hash: asset.hash });
});
