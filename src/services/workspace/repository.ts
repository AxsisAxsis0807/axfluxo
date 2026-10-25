import { z } from "zod";
import {
  newWorkflow,
  viewportSchema,
  type Viewport,
} from "../../domain/workflow/schema";
import { newProject } from "../../domain/document";
import {
  editorRecordSchema,
  revisionSchema,
  parseWorkspace,
  referencedAssets,
  type WorkspaceDocument,
  type EditorRecord,
  type EditorRevision,
  type AssetRef,
  type ImageEditNode,
} from "../../domain/workspace/schema";
import { sha256, imageMime } from "../assets";
import type { Asset } from "../storage";
import { read, write } from "./db";
export class WorkspaceConflict extends Error {
  constructor() {
    super(
      "別タブの更新と競合しました。再読込または別コピー保存を選んでください",
    );
  }
}
export type WorkspaceAsset = Asset & {
  blobMime: "image/png";
  originalMime: string;
};
export type Artifact = {
  id: string;
  key: string;
  revisionId: string;
  pageId: string;
  blob: Blob;
  hash: string;
  width: number;
  height: number;
  format: "png";
  thumbnail: Blob;
};
export type Bundle = {
  editors?: EditorRecord[];
  revisions?: EditorRevision[];
  assets?: WorkspaceAsset[];
};
export const now = () => new Date().toISOString();
export function newWorkspace(): WorkspaceDocument {
  return { ...newWorkflow(), schemaVersion: 2 };
}
export function newEditor(name = "画像編集"): EditorRecord {
  return {
    id: crypto.randomUUID(),
    document: newProject(name),
    assets: {},
    revision: 0,
    updatedAt: now(),
  };
}
export function newImageEdit(
  position = { x: 80, y: 80 },
  editor = newEditor(),
): { node: ImageEditNode; editor: EditorRecord } {
  return {
    editor,
    node: {
      id: crypto.randomUUID(),
      type: "image-edit",
      typeVersion: 1,
      position,
      config: { name: "画像編集", editorDocumentId: editor.id },
    },
  };
}
export async function prepareAsset(asset: Asset): Promise<WorkspaceAsset> {
  const mime = imageMime(
    new Uint8Array(await asset.blob.slice(0, 32).arrayBuffer()),
  );
  if (
    mime !== "image/png" ||
    asset.width < 1 ||
    asset.height < 1 ||
    asset.width * asset.height > 24_000_000 ||
    Math.max(asset.width, asset.height) > 8192
  )
    throw new Error("固定画像の形式または寸法が不正です");
  return {
    ...asset,
    blob: new Blob([asset.blob], { type: "image/png" }),
    hash: await sha256(asset.blob),
    blobMime: "image/png",
    originalMime: asset.mime,
  };
}
export async function storeAsset(asset: Asset): Promise<AssetRef> {
  const prepared = await prepareAsset(asset);
  await write(["assets"], (tx) => {
    tx.objectStore("assets").add(prepared);
  });
  return { assetId: prepared.id, hash: prepared.hash };
}
export async function getAsset(ref: AssetRef): Promise<WorkspaceAsset> {
  const asset = await read<WorkspaceAsset | undefined>("assets", ref.assetId);
  if (
    !asset ||
    asset.hash !== ref.hash ||
    (await sha256(asset.blob)) !== ref.hash
  )
    throw new Error("画像参照が欠損または破損しています");
  return asset;
}
export async function loadEditor(id: string): Promise<EditorRecord> {
  const value = await read<unknown>("editorDocuments", id);
  if (!value) throw new Error("編集文書が見つかりません");
  const record = editorRecordSchema.parse(value);
  await Promise.all(
    referencedAssets(record.document).map(async (id) => {
      const ref = record.assets[id];
      if (!ref) throw new Error("画像対応表が欠損しています");
      await getAsset(ref);
    }),
  );
  for (const ref of Object.values(record.assets)) await getAsset(ref);
  if (record.input) await getAsset(record.input.reference);
  return record;
}
export async function loadRevision(id: string): Promise<EditorRevision> {
  const revision = revisionSchema.parse(await read("editorRevisions", id));
  for (const assetId of referencedAssets(revision.document))
    if (!revision.assets[assetId])
      throw new Error("適用版の画像対応表が欠損しています");
  for (const ref of Object.values(revision.assets)) await getAsset(ref);
  if (revision.input) await getAsset(revision.input.reference);
  return revision;
}
export async function listWorkspaces(): Promise<WorkspaceDocument[]> {
  return (await read<{ document: unknown }[]>("workflows"))
    .map((r) => parseWorkspace(r.document))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function loadWorkspace(id: string) {
  const row = await read<{ document: unknown } | undefined>("workflows", id);
  if (!row) throw new Error("Workflowが見つかりません");
  const document = parseWorkspace(row.document);
  const preference = await read<{ viewport?: unknown } | undefined>(
    "preferences",
    id,
  );
  for (const node of document.nodes) {
    if (
      node.type === "source" &&
      "assetId" in node.config &&
      node.config.assetId
    ) {
      const asset = await read<WorkspaceAsset | undefined>(
        "assets",
        node.config.assetId,
      );
      if (!asset) throw new Error("入力素材が欠損しています");
      await getAsset({ assetId: asset.id, hash: asset.hash });
    }
    if (node.type === "image-edit") {
      if (node.config.selectedAssetRef)
        await getAsset(node.config.selectedAssetRef);
      await loadEditor(node.config.editorDocumentId);
      if (node.config.appliedRevisionId) {
        const revision = await loadRevision(node.config.appliedRevisionId);
        if (revision.editorDocumentId !== node.config.editorDocumentId)
          throw new Error("適用版参照が不正です");
      }
    }
  }
  return {
    document,
    viewport: viewportSchema.parse(
      preference?.viewport ?? { x: 0, y: 0, zoom: 1 },
    ),
  };
}
function guard(
  tx: IDBTransaction,
  id: string,
  expected: number | null,
  done: () => void,
  fail: (e: unknown) => void,
) {
  const r = tx.objectStore("workflows").get(id);
  r.onsuccess = () => {
    try {
      const existing = r.result ? parseWorkspace(r.result.document) : undefined;
      if ((existing?.revision ?? null) !== expected)
        throw new WorkspaceConflict();
      done();
    } catch (e) {
      fail(e);
    }
  };
}
/** Schedules complete reference verification in the transaction before writing. */
function validateEditor(
  tx: IDBTransaction,
  value: EditorRecord | EditorRevision,
  done: () => void,
  fail: (e: unknown) => void,
) {
  const ids = referencedAssets(value.document);
  if (ids.some((id) => !value.assets[id])) {
    fail(new Error("画像対応表が不足しています"));
    return;
  }
  const refs = [
    ...Object.values(value.assets),
    ...(value.input ? [value.input.reference] : []),
  ];
  if (!refs.length) {
    done();
    return;
  }
  let left = refs.length;
  for (const ref of refs) {
    const r = tx.objectStore("assets").get(ref.assetId);
    r.onsuccess = () => {
      if (!r.result || r.result.hash !== ref.hash) {
        fail(new Error("画像参照が不足しています"));
        return;
      }
      if (--left === 0) done();
    };
  }
}
function validateGraph(
  tx: IDBTransaction,
  d: WorkspaceDocument,
  done: () => void,
  fail: (e: unknown) => void,
) {
  const checks: (() => void)[] = [];
  let left = 0;
  const finished = () => {
    if (--left === 0) done();
  };
  for (const node of d.nodes) {
    if (
      node.type === "source" &&
      "assetId" in node.config &&
      node.config.assetId
    ) {
      const assetId = node.config.assetId;
      checks.push(() => {
        const r = tx.objectStore("assets").get(assetId);
        r.onsuccess = () =>
          r.result ? finished() : fail(new Error("入力素材が不足しています"));
      });
    }
    if (node.type !== "image-edit") continue;
    checks.push(() => {
      const r = tx
        .objectStore("editorDocuments")
        .get(node.config.editorDocumentId);
      r.onsuccess = () => {
        try {
          const editor = editorRecordSchema.parse(r.result);
          validateEditor(tx, editor, finished, fail);
        } catch (e) {
          fail(e);
        }
      };
    });
    if (node.config.appliedRevisionId)
      checks.push(() => {
        const r = tx
          .objectStore("editorRevisions")
          .get(node.config.appliedRevisionId!);
        r.onsuccess = () => {
          try {
            const revision = revisionSchema.parse(r.result);
            if (
              revision.editorDocumentId !== node.config.editorDocumentId ||
              !revision.document.pages.some(
                (p) => p.id === node.config.outputPageId,
              )
            )
              throw new Error("適用版または出力ページが不正です");
            validateEditor(tx, revision, finished, fail);
          } catch (e) {
            fail(e);
          }
        };
      });
    if (node.config.selectedAssetRef)
      checks.push(() => {
        const ref = node.config.selectedAssetRef!;
        const r = tx.objectStore("assets").get(ref.assetId);
        r.onsuccess = () =>
          r.result?.hash === ref.hash
            ? finished()
            : fail(new Error("選択素材が不足しています"));
      });
  }
  left = checks.length;
  if (!left) done();
  else checks.forEach((check) => check());
}
function persist(
  tx: IDBTransaction,
  doc: WorkspaceDocument,
  viewport: Viewport,
) {
  tx.objectStore("workflows").put({ id: doc.workflowId, document: doc });
  tx.objectStore("preferences").put({ id: doc.workflowId, viewport });
  tx.objectStore("recovery").put({
    id: `${doc.workflowId}:${doc.revision}`,
    workflowId: doc.workflowId,
    document: doc,
    viewport,
  });
}
export async function saveWorkspace(
  value: WorkspaceDocument,
  viewport: Viewport,
  expected: number | null,
  bundle: Bundle = {},
): Promise<WorkspaceDocument> {
  const doc = parseWorkspace({
      ...value,
      revision: (expected ?? -1) + 1,
      updatedAt: now(),
    }),
    v = viewportSchema.parse(viewport);
  const editors = (bundle.editors ?? []).map((r) =>
    editorRecordSchema.parse(r),
  );
  const revisions = (bundle.revisions ?? []).map((r) =>
    revisionSchema.parse(r),
  );
  await write(
    [
      "workflows",
      "preferences",
      "recovery",
      "editorDocuments",
      "editorRevisions",
      "assets",
    ],
    (tx, fail) => {
      guard(
        tx,
        doc.workflowId,
        expected,
        () => {
          try {
            for (const asset of bundle.assets ?? [])
              tx.objectStore("assets").add(asset);
            for (const editor of editors)
              tx.objectStore("editorDocuments").add(editor);
            for (const revision of revisions)
              tx.objectStore("editorRevisions").add(revision);
            validateGraph(tx, doc, () => persist(tx, doc, v), fail);
          } catch (e) {
            fail(e);
          }
        },
        fail,
      );
    },
  );
  return doc;
}
export async function saveDraft(
  value: EditorRecord,
  expected: number,
): Promise<EditorRecord> {
  const record = editorRecordSchema.parse({
    ...value,
    revision: expected + 1,
    updatedAt: now(),
  });
  await write(["editorDocuments", "assets"], (tx, fail) => {
    const r = tx.objectStore("editorDocuments").get(record.id);
    r.onsuccess = () => {
      try {
        if (
          !r.result ||
          editorRecordSchema.parse(r.result).revision !== expected
        )
          throw new WorkspaceConflict();
        validateEditor(
          tx,
          record,
          () => tx.objectStore("editorDocuments").put(record),
          fail,
        );
      } catch (e) {
        fail(e);
      }
    };
  });
  return record;
}
export async function applyEditor(
  workflow: WorkspaceDocument,
  viewport: Viewport,
  nodeId: string,
  draft: EditorRecord,
  expectedWorkflow: number,
  expectedEditor: number,
  pageId: string,
) {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (
    !node ||
    node.type !== "image-edit" ||
    node.config.editorDocumentId !== draft.id ||
    !draft.document.pages.some((p) => p.id === pageId)
  )
    throw new Error("編集対象が変わりました");
  const record = editorRecordSchema.parse({
    ...draft,
    revision: expectedEditor + 1,
    updatedAt: now(),
  });
  const revision = revisionSchema.parse({
    id: crypto.randomUUID(),
    editorDocumentId: draft.id,
    document: structuredClone(draft.document),
    assets: structuredClone(draft.assets),
    input: draft.input,
    updatedAt: now(),
  });
  const doc = parseWorkspace({
    ...workflow,
    revision: expectedWorkflow + 1,
    updatedAt: now(),
    nodes: workflow.nodes.map((n) =>
      n.id === nodeId
        ? {
            ...node,
            config: {
              ...node.config,
              appliedRevisionId: revision.id,
              outputPageId: pageId,
            },
          }
        : n,
    ),
  });
  await write(
    [
      "workflows",
      "preferences",
      "recovery",
      "editorDocuments",
      "editorRevisions",
      "assets",
    ],
    (tx, fail) => {
      guard(
        tx,
        doc.workflowId,
        expectedWorkflow,
        () => {
          const r = tx.objectStore("editorDocuments").get(record.id);
          r.onsuccess = () => {
            try {
              if (
                !r.result ||
                editorRecordSchema.parse(r.result).revision !== expectedEditor
              )
                throw new WorkspaceConflict();
              validateEditor(
                tx,
                record,
                () => {
                  tx.objectStore("editorDocuments").put(record);
                  tx.objectStore("editorRevisions").add(revision);
                  persist(tx, doc, viewportSchema.parse(viewport));
                },
                fail,
              );
            } catch (e) {
              fail(e);
            }
          };
        },
        fail,
      );
    },
  );
  return { document: doc, editor: record, revision };
}
export async function duplicateEditor(node: ImageEditNode) {
  const editor = await loadEditor(node.config.editorDocumentId),
    id = crypto.randomUUID();
  const copy: EditorRecord = {
    ...structuredClone(editor),
    id,
    document: { ...structuredClone(editor.document), id: crypto.randomUUID() },
    revision: 0,
    updatedAt: now(),
  };
  let revision: EditorRevision | undefined;
  if (node.config.appliedRevisionId)
    revision = {
      ...structuredClone(await loadRevision(node.config.appliedRevisionId)),
      id: crypto.randomUUID(),
      editorDocumentId: id,
    };
  if (revision) revision.document.id = copy.document.id;
  return {
    editor: copy,
    revision,
    node: {
      ...structuredClone(node),
      id: crypto.randomUUID(),
      position: { x: node.position.x + 40, y: node.position.y + 40 },
      config: {
        ...node.config,
        editorDocumentId: id,
        appliedRevisionId: revision?.id,
      },
    } as ImageEditNode,
  };
}
export async function resolverFor(
  record: Pick<EditorRecord, "document" | "assets">,
) {
  const data = new Map<string, WorkspaceAsset>();
  for (const id of referencedAssets(record.document)) {
    if (!record.assets[id]) throw new Error("画像参照がありません");
    data.set(id, await getAsset(record.assets[id]));
  }
  return async (id: string) => {
    const asset = data.get(id);
    if (!asset) throw new Error("画像が見つかりません");
    return asset;
  };
}
export async function currentOutput(workflowId: string, nodeId: string) {
  const pref = await read<{ artifactId: string } | undefined>(
    "preferences",
    `output:${workflowId}:${nodeId}`,
  );
  return pref
    ? read<Artifact | undefined>("artifacts", pref.artifactId)
    : undefined;
}
export async function publishArtifact(
  workflowId: string,
  nodeId: string,
  artifact: Artifact,
  signal: AbortSignal,
) {
  let adopted = false;
  await write(["workflows", "artifacts", "preferences"], (tx, fail) => {
    const cancel = () =>
      fail(
        signal.reason ??
          new DOMException("生成をキャンセルしました", "AbortError"),
      );
    const detach = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    tx.addEventListener("complete", detach, { once: true });
    tx.addEventListener("abort", detach, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    const r = tx.objectStore("workflows").get(workflowId);
    r.onsuccess = () => {
      try {
        signal.throwIfAborted();
        const node = parseWorkspace(r.result?.document).nodes.find(
          (n) => n.id === nodeId,
        );
        if (
          !node ||
          node.type !== "image-edit" ||
          node.config.appliedRevisionId !== artifact.revisionId ||
          node.config.outputPageId !== artifact.pageId
        )
          return;
        tx.objectStore("artifacts").put(artifact);
        tx.objectStore("preferences").put({
          id: `output:${workflowId}:${nodeId}`,
          artifactId: artifact.id,
        });
        adopted = true;
      } catch (e) {
        fail(e);
      }
    };
  });
  return adopted;
}
export const artifactMetadataSchema = z
  .object({
    id: z.string().uuid(),
    key: z.string().regex(/^[a-f0-9]{64}$/),
    revisionId: z.string().uuid(),
    pageId: z.string().uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().min(64).max(4096),
    height: z.number().int().min(64).max(4096),
    format: z.literal("png"),
  })
  .strict();
