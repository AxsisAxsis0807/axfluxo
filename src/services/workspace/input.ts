import {
  baseLayer,
  defaultCrop,
  newProject,
  type ImageLayer,
} from "../../domain/document";
import type {
  AssetRef,
  EditorRecord,
  ImageEditNode,
  WorkspaceDocument,
} from "../../domain/workspace/schema";
import { read, write } from "./db";
import {
  currentOutput,
  getAsset,
  prepareAsset,
  type WorkspaceAsset,
} from "./repository";
export async function resolveInput(
  doc: WorkspaceDocument,
  node: ImageEditNode,
  signal: AbortSignal,
): Promise<AssetRef | null> {
  signal.throwIfAborted();
  if (!node.config.inputMode) throw new Error("入力方法が未設定です");
  if (node.config.inputMode === "blank") return null;
  if (node.config.inputMode === "selected") {
    if (!node.config.selectedAssetRef) throw new Error("素材が未選択です");
    await getAsset(node.config.selectedAssetRef);
    signal.throwIfAborted();
    return node.config.selectedAssetRef;
  }
  const edge = doc.edges.find(
    (e) => e.targetNodeId === node.id && e.targetPortId === "in",
  );
  const upstream = doc.nodes.find((n) => n.id === edge?.sourceNodeId);
  if (!upstream) throw new Error("入力が接続されていません");
  if (
    upstream.type === "source" &&
    "assetId" in upstream.config &&
    upstream.config.assetId
  ) {
    const asset = await read<WorkspaceAsset | undefined>(
      "assets",
      upstream.config.assetId,
    );
    if (!asset) throw new Error("入力画像がありません");
    const ref = { assetId: asset.id, hash: asset.hash };
    await getAsset(ref);
    signal.throwIfAborted();
    return ref;
  }
  if (upstream.type !== "image-edit")
    throw new Error("上流入力は未生成です。画像処理の実行エンジンは未実装です");
  const artifact = await currentOutput(doc.workflowId, upstream.id);
  if (
    !artifact ||
    artifact.revisionId !== upstream.config.appliedRevisionId ||
    artifact.pageId !== upstream.config.outputPageId
  )
    throw new Error("上流入力は未生成または古い出力です");
  let asset = await read<WorkspaceAsset | undefined>("assets", artifact.id);
  if (!asset) {
    asset = await prepareAsset({
      id: artifact.id,
      name: upstream.config.name,
      blob: artifact.blob,
      original: artifact.blob,
      mime: "image/png",
      hash: artifact.hash,
      width: artifact.width,
      height: artifact.height,
    });
    signal.throwIfAborted();
    await write(["assets"], (tx, fail) => {
      const r = tx.objectStore("assets").get(asset!.id);
      r.onsuccess = () => {
        try {
          if (!r.result) tx.objectStore("assets").add(asset);
        } catch (e) {
          fail(e);
        }
      };
    });
  }
  signal.throwIfAborted();
  return { assetId: asset.id, hash: asset.hash };
}
export function inputChanged(editor: EditorRecord, reference: AssetRef | null) {
  return reference
    ? editor.input?.reference.hash !== reference.hash ||
        editor.input.reference.assetId !== reference.assetId
    : !!editor.input;
}
export async function initializeInput(
  editor: EditorRecord,
  ref: AssetRef | null,
  source: string,
): Promise<EditorRecord> {
  if (!ref) return { ...editor, input: undefined };
  const asset = await getAsset(ref),
    doc = structuredClone(editor.document),
    page = doc.pages[0];
  const layer: ImageLayer = {
    ...baseLayer("image"),
    kind: "image",
    assetId: crypto.randomUUID(),
    width: Math.min(page.width, 900),
    height: Math.min(page.height, 900),
    x: page.width / 2,
    y: page.height / 2,
    crop: defaultCrop(),
    effects: { brightness: 1, contrast: 1, saturation: 1, blur: 0 },
  };
  void asset;
  page.layers.unshift(layer);
  return {
    ...editor,
    document: doc,
    assets: { ...editor.assets, [layer.assetId]: ref },
    input: { reference: ref, layerId: layer.id, source },
  };
}
export async function replaceInput(
  editor: EditorRecord,
  ref: AssetRef | null,
  source: string,
  rebuild: boolean,
) {
  if (rebuild)
    return initializeInput(
      {
        ...editor,
        document: newProject(editor.document.name),
        assets: {},
        input: undefined,
      },
      ref,
      source,
    );
  if (!ref || !editor.input)
    throw new Error(
      "差し替え対象の固定入力がありません。新入力から作り直してください",
    );
  await getAsset(ref);
  const next = structuredClone(editor),
    assetId = crypto.randomUUID();
  let replaced = false;
  for (const page of next.document.pages)
    page.layers = page.layers.map((layer) => {
      if (layer.id !== editor.input!.layerId || layer.kind !== "image")
        return layer;
      replaced = true;
      return { ...layer, assetId, imageBinding: undefined };
    });
  if (!replaced)
    throw new Error(
      "入力レイヤーは削除されています。新入力から作り直してください",
    );
  next.assets[assetId] = ref;
  next.input = { reference: ref, layerId: editor.input.layerId, source };
  return next;
}
