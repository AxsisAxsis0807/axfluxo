import { cloneProject } from "../../domain/document";
import { parseWorkflow } from "../../domain/workflow/connections";
import { get, all, type Asset } from "../storage";
import { decodeImage, imageMime, sha256 } from "../assets";
import type { ProjectDocument } from "../../domain/document";
import { openWorkflowDB, requestValue } from "../workflow/db";
import { loadWorkflow } from "../workflow/repository";
import { read, write } from "./db";
import {
  newWorkspace,
  newImageEdit,
  now,
  prepareAsset,
  type WorkspaceAsset,
} from "./repository";
import type { AssetRef } from "../../domain/workspace/schema";
export async function legacyWorkflows() {
  const db = await openWorkflowDB();
  try {
    return (
      await requestValue(
        db.transaction("workflows").objectStore("workflows").getAll(),
      )
    ).map((r) => parseWorkflow(r.document));
  } finally {
    db.close();
  }
}
export const legacyProjects = () => all<ProjectDocument>("projects");
export async function copyAssets(ids: string[]) {
  const assets: WorkspaceAsset[] = [],
    refs: Record<string, AssetRef> = {};
  for (const id of new Set(ids)) {
    const asset = await get<Asset>("assets", id);
    if (!asset)
      throw new Error("旧画像が見つかりません。元データは変更していません");
    if (
      (await sha256(asset.blob)) !== asset.hash ||
      asset.original.size > 20 * 1024 * 1024 ||
      imageMime(
        new Uint8Array(await asset.original.slice(0, 32).arrayBuffer()),
      ) !== asset.mime
    )
      throw new Error(
        "旧画像のhashまたは原本形式が不正です。元データは保持されています",
      );
    const normalized = await decodeImage(asset.blob),
      original = await decodeImage(asset.original);
    if (
      normalized.naturalWidth !== asset.width ||
      normalized.naturalHeight !== asset.height ||
      original.naturalWidth !== asset.width ||
      original.naturalHeight !== asset.height
    )
      throw new Error("旧画像のデコード寸法が一致しません");
    const copy = await prepareAsset({ ...asset, id: crypto.randomUUID() });
    assets.push(copy);
    refs[id] = { assetId: copy.id, hash: copy.hash };
  }
  return { assets, refs };
}
export async function importLegacyWorkflow(id: string) {
  const loaded = await loadWorkflow(id);
  if (!loaded.document) throw new Error("旧Workflowが見つかりません");
  const source = loaded.document,
    migrationId = `${id}:${source.revision}`;
  const previous = await read<{ workflowId: string } | undefined>(
    "migrations",
    migrationId,
  );
  if (previous) return previous.workflowId;
  const { assets, refs } = await copyAssets(
    source.nodes.flatMap((n) =>
      n.type === "source" && "assetId" in n.config && n.config.assetId
        ? [n.config.assetId]
        : [],
    ),
  );
  const doc = {
    ...source,
    schemaVersion: 2 as const,
    workflowId: crypto.randomUUID(),
    revision: 0,
    name: `${source.name.slice(0, 180)}（取り込み）`,
    createdAt: now(),
    updatedAt: now(),
    nodes: source.nodes.map((n) =>
      n.type === "source" && "assetId" in n.config && n.config.assetId
        ? { ...n, config: { assetId: refs[n.config.assetId].assetId } }
        : n,
    ),
  };
  // Node IDs are scoped to a workflow, but copies still receive fresh IDs.
  const nodes = new Map(doc.nodes.map((n) => [n.id, crypto.randomUUID()]));
  doc.nodes = doc.nodes.map((n) => ({ ...n, id: nodes.get(n.id)! }));
  doc.edges = doc.edges.map((e) => ({
    ...e,
    id: crypto.randomUUID(),
    sourceNodeId: nodes.get(e.sourceNodeId)!,
    targetNodeId: nodes.get(e.targetNodeId)!,
  }));
  let result = doc.workflowId;
  await write(
    ["migrations", "assets", "workflows", "preferences", "recovery"],
    (tx, fail) => {
      const r = tx.objectStore("migrations").get(migrationId);
      r.onsuccess = () => {
        try {
          if (r.result) {
            result = r.result.workflowId;
            return;
          }
          for (const asset of assets) tx.objectStore("assets").add(asset);
          tx.objectStore("workflows").add({
            id: doc.workflowId,
            document: doc,
          });
          tx.objectStore("preferences").add({
            id: doc.workflowId,
            viewport: loaded.viewport,
          });
          tx.objectStore("recovery").add({
            id: `${doc.workflowId}:0`,
            workflowId: doc.workflowId,
            document: doc,
            viewport: loaded.viewport,
          });
          tx.objectStore("migrations").add({
            id: migrationId,
            sourceId: id,
            sourceRevision: source.revision,
            workflowId: doc.workflowId,
            importedAt: now(),
          });
        } catch (e) {
          fail(e);
        }
      };
    },
  );
  return result;
}
export async function prepareLegacyProject(project: ProjectDocument) {
  const { referencedAssets } = await import("../../domain/workspace/schema");
  const { assets, refs } = await copyAssets(referencedAssets(project));
  const pair = newImageEdit();
  pair.editor.document = cloneProject(project);
  pair.editor.assets = refs;
  pair.node.config = {
    ...pair.node.config,
    name: project.name,
    inputMode: "blank",
  };
  return { ...pair, assets };
}
export async function migrationState(id: string, revision: number) {
  const rows =
    await read<
      { sourceId: string; sourceRevision: number; workflowId: string }[]
    >("migrations");
  const imported = rows.filter((r) => r.sourceId === id);
  return imported.some((r) => r.sourceRevision === revision)
    ? "取り込み済み（同じコピーを開く）"
    : imported.length
      ? "元が更新されています（別コピーとして取り込み）"
      : "旧版をコピー取り込み";
}
export { newWorkspace };
