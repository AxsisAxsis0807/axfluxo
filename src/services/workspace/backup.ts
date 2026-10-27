import { z } from "zod";
import {
  exportLibrary,
  parseLibraryMetadata,
  prepareLibraryRestore,
  scheduleLibraryRestore,
} from "../library/backup";
import { strFromU8, strToU8, zipSync } from "fflate";
import fonts from "../../../public/fonts/manifest.json";
import { LIMITS } from "../../config/limits";
import { documentSchema, type ProjectDocument } from "../../domain/document";
import { viewportSchema } from "../../domain/workflow/schema";
import {
  workspaceSchema,
  parseWorkspace,
  editorRecordSchema,
  revisionSchema,
  referencedAssets,
  type AssetRef,
  type EditorRecord,
  type EditorRevision,
} from "../../domain/workspace/schema";
import { unzipWithPolicy } from "../archive";
import { sha256, importImage } from "../assets";
import { imageEditRenderKey } from "../editor/render-image-edit";
import { read, write } from "./db";
import {
  loadWorkspace,
  loadEditor,
  loadRevision,
  getAsset,
  currentOutput,
  artifactMetadataSchema,
  now,
  type Artifact,
  type WorkspaceAsset,
} from "./repository";
const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const assetMetadata = z
  .object({
    id: uuid,
    name: z.string().max(1024),
    hash,
    originalHash: hash,
    originalMime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
  })
  .strict();
const manifestSchema = z
  .object({
    identifier: z.literal("axfluxo-workspace"),
    formatVersion: z.union([z.literal(1), z.literal(2)]),
    library: z.unknown().optional(),
    renderVersion: z.literal(1),
    fonts: z.unknown(),
    assets: z.array(assetMetadata).max(500),
    artifacts: z
      .array(artifactMetadataSchema.extend({ thumbnailHash: hash }))
      .max(200),
  })
  .strict();
const payloadSchema = z
  .object({
    workflow: workspaceSchema,
    viewport: viewportSchema,
    editors: z.array(editorRecordSchema).max(200),
    revisions: z.array(revisionSchema).max(200),
    outputs: z.record(uuid, uuid),
  })
  .strict();
function parseJSON(bytes: Uint8Array | undefined): unknown {
  if (!bytes || bytes.length > LIMITS.jsonBytes)
    throw new Error("JSONが不足または大きすぎます");
  const data: unknown = JSON.parse(strFromU8(bytes));
  const depth = (v: unknown, n = 0) => {
    if (n > 32) throw new Error("JSONが深すぎます");
    if (v && typeof v === "object")
      Object.values(v).forEach((x) => depth(x, n + 1));
  };
  depth(data);
  return data;
}
export async function backupWorkspace(id: string): Promise<Blob> {
  const { document: workflow, viewport } = await loadWorkspace(id),
    editors: EditorRecord[] = [],
    revisions: EditorRevision[] = [],
    artifacts: Artifact[] = [],
    outputs: Record<string, string> = {};
  for (const node of workflow.nodes)
    if (node.type === "image-edit") {
      editors.push(await loadEditor(node.config.editorDocumentId));
      if (node.config.appliedRevisionId)
        revisions.push(await loadRevision(node.config.appliedRevisionId));
      const output = await currentOutput(id, node.id);
      if (
        output &&
        output.revisionId === node.config.appliedRevisionId &&
        output.pageId === node.config.outputPageId
      ) {
        artifacts.push(output);
        outputs[node.id] = output.id;
      }
    }
  const refs = new Map<string, AssetRef>();
  for (const record of [...editors, ...revisions]) {
    for (const id of referencedAssets(record.document))
      if (!record.assets[id]) throw new Error("画像対応表が不足しています");
    for (const ref of Object.values(record.assets)) refs.set(ref.assetId, ref);
    if (record.input)
      refs.set(record.input.reference.assetId, record.input.reference);
  }
  for (const node of workflow.nodes) {
    if (node.type === "image-edit" && node.config.selectedAssetRef)
      refs.set(
        node.config.selectedAssetRef.assetId,
        node.config.selectedAssetRef,
      );
    if (
      node.type === "source" &&
      "assetId" in node.config &&
      node.config.assetId
    ) {
      const asset = await read<WorkspaceAsset>("assets", node.config.assetId);
      if (!asset) throw new Error("入力素材が不足しています");
      refs.set(asset.id, { assetId: asset.id, hash: asset.hash });
    }
  }
  const entries: Record<string, Uint8Array> = {},
    assetMeta: z.infer<typeof assetMetadata>[] = [],
    artifactMeta: z.infer<typeof manifestSchema>["artifacts"] = [];
  for (const ref of refs.values()) {
    const asset = await getAsset(ref);
    entries[`assets/${asset.id}.png`] = new Uint8Array(
      await asset.blob.arrayBuffer(),
    );
    entries[`assets/${asset.id}.original`] = new Uint8Array(
      await asset.original.arrayBuffer(),
    );
    assetMeta.push({
      id: asset.id,
      name: asset.name,
      hash: asset.hash,
      originalHash: await sha256(asset.original),
      originalMime: asset.originalMime as "image/png",
      width: asset.width,
      height: asset.height,
    });
  }
  for (const artifact of artifacts) {
    entries[`artifacts/${artifact.id}.png`] = new Uint8Array(
      await artifact.blob.arrayBuffer(),
    );
    entries[`artifacts/${artifact.id}.thumb.png`] = new Uint8Array(
      await artifact.thumbnail.arrayBuffer(),
    );
    const { blob: _blob, thumbnail: _thumbnail, ...meta } = artifact;
    void _blob;
    void _thumbnail;
    artifactMeta.push({
      ...meta,
      thumbnailHash: await sha256(artifact.thumbnail),
    });
  }
  const library = await exportLibrary(entries);
  const payload = { workflow, viewport, editors, revisions, outputs },
    manifest = {
      identifier: "axfluxo-workspace",
      formatVersion: 2,
      library,
      renderVersion: 1,
      fonts,
      assets: assetMeta,
      artifacts: artifactMeta,
    };
  entries["workspace.json"] = strToU8(JSON.stringify(payload));
  entries["manifest.json"] = strToU8(JSON.stringify(manifest));
  if (
    entries["workspace.json"].length > LIMITS.jsonBytes ||
    entries["manifest.json"].length > LIMITS.jsonBytes ||
    Object.keys(entries).length > LIMITS.entries ||
    Object.values(entries).reduce((n, b) => n + b.length, 0) >
      LIMITS.archiveBytes
  )
    throw new Error("バックアップ容量の上限です");
  return new Blob([zipSync(entries) as Uint8Array<ArrayBuffer>], {
    type: "application/zip",
  });
}
export async function restoreWorkspace(
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (file.size > LIMITS.archiveBytes)
    throw new Error("ZIPは200MiB以下にしてください");
  const restoreKey = `backup:${await sha256(file)}`;
  const entries = unzipWithPolicy(
    new Uint8Array(await file.arrayBuffer()),
    /^(manifest\.json|workspace\.json|assets\/[0-9a-f-]+\.(png|original)|artifacts\/[0-9a-f-]+\.(png|thumb\.png)|library\/[\w-]+\.(image|original))$/i,
  );
  const manifest = manifestSchema.parse(parseJSON(entries["manifest.json"])),
    payload = payloadSchema.parse(parseJSON(entries["workspace.json"]));
  parseWorkspace(payload.workflow);
  if (manifest.formatVersion === 1 && manifest.library !== undefined)
    throw new Error("旧形式に素材拡張は含められません");
  const library =
    manifest.formatVersion === 2
      ? parseLibraryMetadata(manifest.library)
      : { files: [], folders: [], versions: [] };
  const expectedEntries = new Set([
    "manifest.json",
    "workspace.json",
    ...library.versions.flatMap((v) => [
      `library/${v.id}.image`,
      `library/${v.id}.original`,
    ]),
    ...manifest.assets.flatMap((a) => [
      `assets/${a.id}.png`,
      `assets/${a.id}.original`,
    ]),
    ...manifest.artifacts.flatMap((a) => [
      `artifacts/${a.id}.png`,
      `artifacts/${a.id}.thumb.png`,
    ]),
  ]);
  if (
    Object.keys(entries).length !== expectedEntries.size ||
    Object.keys(entries).some((name) => !expectedEntries.has(name))
  )
    throw new Error("manifestにないZIP entryです");
  if (JSON.stringify(manifest.fonts) !== JSON.stringify(fonts))
    throw new Error("フォントの版が一致しません");
  const unique = (ids: string[]) => {
    if (new Set(ids).size !== ids.length) throw new Error("IDが重複しています");
  };
  unique(manifest.assets.map((a) => a.id));
  unique(manifest.artifacts.map((a) => a.id));
  unique(payload.editors.map((e) => e.id));
  unique(payload.revisions.map((e) => e.id));
  const bytes = (path: string) => {
    const value = entries[path];
    if (!value) throw new Error("画像entryが不足しています");
    return value as Uint8Array<ArrayBuffer>;
  };
  const assetIds = new Map(
      manifest.assets.map((a) => [a.id, crypto.randomUUID()]),
    ),
    editorIds = new Map(
      payload.editors.map((e) => [e.id, crypto.randomUUID()]),
    ),
    revisionIds = new Map(
      payload.revisions.map((e) => [e.id, crypto.randomUUID()]),
    ),
    nodeIds = new Map(
      payload.workflow.nodes.map((n) => [n.id, crypto.randomUUID()]),
    );
  const documentIds = new Map<string, string>(),
    aliasIds = new Map<string, string>();
  const mapped = (map: Map<string, string>, id: string) => {
    const value = map.get(id);
    if (!value) throw new Error("文書の内部参照が欠損しています");
    return value;
  };
  const fresh = (map: Map<string, string>, id: string) => {
    if (!map.has(id)) map.set(id, crypto.randomUUID());
    return map.get(id)!;
  };
  const ref = (value: AssetRef): AssetRef => {
    const meta = manifest.assets.find((a) => a.id === value.assetId);
    if (!meta || meta.hash !== value.hash)
      throw new Error("画像参照hashが不正です");
    return { assetId: mapped(assetIds, value.assetId), hash: value.hash };
  };
  const assets: WorkspaceAsset[] = [];
  for (const meta of manifest.assets) {
    const png = bytes(`assets/${meta.id}.png`),
      original = bytes(`assets/${meta.id}.original`);
    const blob = new Blob([png], { type: "image/png" }),
      originalBlob = new Blob([original], { type: meta.originalMime });
    if (
      (await sha256(blob)) !== meta.hash ||
      (await sha256(originalBlob)) !== meta.originalHash
    )
      throw new Error("画像hashが一致しません");
    const validated = await importImage(new File([blob], meta.name), true),
      validatedOriginal = await importImage(
        new File([originalBlob], meta.name),
      );
    if (
      validated.width !== meta.width ||
      validated.height !== meta.height ||
      validatedOriginal.mime !== meta.originalMime
    )
      throw new Error("画像寸法またはMIMEが不正です");
    assets.push({
      ...validated,
      id: mapped(assetIds, meta.id),
      blob,
      original: originalBlob,
      mime: meta.originalMime,
      originalMime: meta.originalMime,
      blobMime: "image/png",
      hash: meta.hash,
    });
  }
  function remapDocument(document: ProjectDocument) {
    const doc = structuredClone(document);
    doc.id = fresh(documentIds, doc.id);
    for (const page of doc.pages) {
      page.id = fresh(documentIds, page.id);
      for (const layer of page.layers) {
        layer.id = fresh(documentIds, layer.id);
        if (layer.kind === "image")
          layer.assetId = fresh(aliasIds, layer.assetId);
      }
    }
    for (const variable of doc.variables.filter((v) => v.type === "image")) {
      if (typeof variable.default === "string" && variable.default)
        variable.default = fresh(aliasIds, variable.default);
      if (
        typeof doc.values[variable.key] === "string" &&
        doc.values[variable.key]
      )
        doc.values[variable.key] = fresh(
          aliasIds,
          String(doc.values[variable.key]),
        );
    }
    return documentSchema.parse(doc);
  }
  function remapRecord<T extends EditorRecord | EditorRevision>(record: T) {
    for (const id of referencedAssets(record.document))
      if (!record.assets[id]) throw new Error("画像対応表が不足しています");
    const document = remapDocument(record.document),
      refs = Object.fromEntries(
        Object.entries(record.assets).map(([key, value]) => [
          fresh(aliasIds, key),
          ref(value),
        ]),
      );
    const input = record.input
      ? {
          ...record.input,
          reference: ref(record.input.reference),
          layerId: fresh(documentIds, record.input.layerId),
          source: nodeIds.get(record.input.source) ?? record.input.source,
        }
      : undefined;
    return { ...record, document, assets: refs, input, updatedAt: now() };
  }
  const editors = payload.editors.map((e) =>
    editorRecordSchema.parse({
      ...remapRecord(e),
      id: mapped(editorIds, e.id),
      revision: 0,
    }),
  );
  const revisions = payload.revisions.map((e) =>
    revisionSchema.parse({
      ...remapRecord(e),
      id: mapped(revisionIds, e.id),
      editorDocumentId: mapped(editorIds, e.editorDocumentId),
    }),
  );
  const workflow = parseWorkspace({
    ...payload.workflow,
    workflowId: crypto.randomUUID(),
    revision: 0,
    createdAt: now(),
    updatedAt: now(),
    name: `${payload.workflow.name.slice(0, 185)}（復元）`,
    nodes: payload.workflow.nodes.map((n) => ({
      ...n,
      id: mapped(nodeIds, n.id),
      config:
        n.type === "image-edit"
          ? {
              ...n.config,
              editorDocumentId: mapped(editorIds, n.config.editorDocumentId),
              appliedRevisionId: n.config.appliedRevisionId
                ? mapped(revisionIds, n.config.appliedRevisionId)
                : undefined,
              outputPageId: n.config.outputPageId
                ? mapped(documentIds, n.config.outputPageId)
                : undefined,
              selectedAssetRef: n.config.selectedAssetRef
                ? ref(n.config.selectedAssetRef)
                : undefined,
            }
          : n.type === "source" && "assetId" in n.config && n.config.assetId
            ? { assetId: mapped(assetIds, n.config.assetId) }
            : n.config,
    })),
    edges: payload.workflow.edges.map((e) => ({
      ...e,
      id: crypto.randomUUID(),
      sourceNodeId: mapped(nodeIds, e.sourceNodeId),
      targetNodeId: mapped(nodeIds, e.targetNodeId),
    })),
  });
  for (const n of workflow.nodes)
    if (n.type === "image-edit") {
      if (!editors.some((e) => e.id === n.config.editorDocumentId))
        throw new Error("編集文書が不足しています");
      if (n.config.appliedRevisionId) {
        const revision = revisions.find(
          (r) => r.id === n.config.appliedRevisionId,
        );
        if (
          !revision ||
          revision.editorDocumentId !== n.config.editorDocumentId ||
          !revision.document.pages.some((p) => p.id === n.config.outputPageId)
        )
          throw new Error("適用版または出力ページが不正です");
      }
    }
  const artifactIds = new Map<string, string>(),
    artifacts: Artifact[] = [];
  for (const meta of manifest.artifacts) {
    const blob = new Blob([bytes(`artifacts/${meta.id}.png`)], {
        type: "image/png",
      }),
      thumbnail = new Blob([bytes(`artifacts/${meta.id}.thumb.png`)], {
        type: "image/png",
      });
    if (
      (await sha256(blob)) !== meta.hash ||
      (await sha256(thumbnail)) !== meta.thumbnailHash
    )
      throw new Error("出力画像hashが不正です");
    const image = await importImage(new File([blob], "output.png"), true);
    await importImage(new File([thumbnail], "thumbnail.png"), true);
    if (image.width !== meta.width || image.height !== meta.height)
      throw new Error("出力寸法が不正です");
    const id = crypto.randomUUID();
    artifactIds.set(meta.id, id);
    artifacts.push({
      id,
      key: await imageEditRenderKey(
        revisions.find((r) => r.id === mapped(revisionIds, meta.revisionId))!,
        mapped(documentIds, meta.pageId),
      ),
      revisionId: mapped(revisionIds, meta.revisionId),
      pageId: mapped(documentIds, meta.pageId),
      blob,
      thumbnail,
      hash: meta.hash,
      width: meta.width,
      height: meta.height,
      format: "png",
    });
  }
  const outputPointers = Object.entries(payload.outputs).map(
    ([nodeId, artifactId]) => {
      const node = workflow.nodes.find((n) => n.id === mapped(nodeIds, nodeId)),
        artifact = artifacts.find(
          (a) => a.id === mapped(artifactIds, artifactId),
        );
      if (
        !artifact ||
        !node ||
        node.type !== "image-edit" ||
        artifact?.revisionId !== node.config.appliedRevisionId ||
        artifact?.pageId !== node.config.outputPageId
      )
        throw new Error("出力参照が不正です");
      return {
        id: `output:${workflow.workflowId}:${node.id}`,
        artifactId: artifact.id,
      };
    },
  );

  const preparedLibrary = await prepareLibraryRestore(library, entries, signal);
  for (const n of workflow.nodes)
    if (
      n.type === "source" &&
      "libraryRef" in n.config &&
      n.config.libraryRef
    ) {
      const ref = n.config.libraryRef;
      if (
        !library.versions.some(
          (v) =>
            v.id === ref.versionId &&
            v.fileId === ref.fileId &&
            v.libraryId === ref.libraryId &&
            v.hash === ref.hash,
        )
      )
        throw new Error("Workflowの素材version参照が欠損しています");
    }
  signal?.throwIfAborted();
  let restoredId = workflow.workflowId;
  // All parsing, decoding, hashes and remapping have finished before publication.
  await write(
    [
      "workflows",
      "preferences",
      "editorDocuments",
      "editorRevisions",
      "assets",
      "artifacts",
      "recovery",
      "migrations",
      "libraryFiles",
      "libraryVersions",
      "libraryFolders",
      "libraryReferences",
    ],
    (tx, fail) => {
      const abort = () => fail(new Error("復元を中断しました"));
      signal?.addEventListener("abort", abort, { once: true });
      const detach = () => signal?.removeEventListener("abort", abort);
      tx.addEventListener("complete", detach);
      tx.addEventListener("abort", detach);
      if (signal?.aborted) {
        abort();
        return;
      }
      const check = tx.objectStore("migrations").get(restoreKey);
      check.onsuccess = () => {
        if (check.result) {
          restoredId = check.result.workflowId;
          return;
        }
        scheduleLibraryRestore(tx, preparedLibrary, fail);
        tx.objectStore("migrations").add({
          id: restoreKey,
          workflowId: workflow.workflowId,
        });
        for (const n of workflow.nodes)
          if (
            n.type === "source" &&
            "libraryRef" in n.config &&
            n.config.libraryRef
          )
            tx.objectStore("libraryReferences").put({
              id: `workflow:${workflow.workflowId}:${n.config.libraryRef.versionId}`,
              owner: workflow.workflowId,
              reference: n.config.libraryRef,
            });
        for (const asset of assets) tx.objectStore("assets").add(asset);
        for (const editor of editors)
          tx.objectStore("editorDocuments").add(editor);
        for (const revision of revisions)
          tx.objectStore("editorRevisions").add(revision);
        for (const artifact of artifacts)
          tx.objectStore("artifacts").add(artifact);
        for (const pointer of outputPointers)
          tx.objectStore("preferences").add(pointer);
        tx.objectStore("workflows").add({
          id: workflow.workflowId,
          document: workflow,
        });
        tx.objectStore("preferences").add({
          id: workflow.workflowId,
          viewport: payload.viewport,
        });
        tx.objectStore("recovery").add({
          id: `${workflow.workflowId}:0`,
          workflowId: workflow.workflowId,
          document: workflow,
          viewport: payload.viewport,
        });
      };
    },
  );
  return restoredId;
}
