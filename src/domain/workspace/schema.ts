import { z } from "zod";
import { documentSchema, type ProjectDocument } from "../document";
import {
  nodeSchema,
  workflowSchema,
  definitions,
  type WorkflowNode,
  type Port,
} from "../workflow/schema";
import { connectionError } from "../workflow/connections";
import {
  executionNodeSchema,
  executionDefinitions,
  isExecutionNode,
} from "../workflow/execution-schema";
const uuid = z.string().uuid();
export const assetRefSchema = z
  .object({ assetId: uuid, hash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type AssetRef = z.infer<typeof assetRefSchema>;
export const imageEditConfigSchema = z
  .object({
    name: z.string().min(1).max(200),
    inputMode: z.enum(["connected", "selected", "blank"]).optional(),
    selectedAssetRef: assetRefSchema.optional(),
    editorDocumentId: uuid,
    appliedRevisionId: uuid.optional(),
    outputPageId: uuid.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.inputMode === "selected" && !c.selectedAssetRef)
      ctx.addIssue({ code: "custom", message: "素材を選択してください" });
  });
export const imageEditNodeSchema = z
  .object({
    id: uuid,
    type: z.literal("image-edit"),
    typeVersion: z.literal(1),
    position: z
      .object({
        x: z.number().finite().min(-1e6).max(1e6),
        y: z.number().finite().min(-1e6).max(1e6),
      })
      .strict(),
    config: imageEditConfigSchema,
  })
  .strict();
export const workspaceSchema = z
  .object({
    ...workflowSchema.shape,
    schemaVersion: z.literal(2),
    nodes: z
      .array(z.union([nodeSchema, imageEditNodeSchema, executionNodeSchema]))
      .max(200),
  })
  .strict()
  .superRefine((doc, ctx) => {
    for (const list of [doc.nodes, doc.edges])
      if (new Set(list.map((n) => n.id)).size !== list.length)
        ctx.addIssue({ code: "custom", message: "IDが重複しています" });
  });
export type WorkspaceDocument = z.infer<typeof workspaceSchema>;
export type ImageEditNode = z.infer<typeof imageEditNodeSchema>;
export type WorkspaceNode = WorkspaceDocument["nodes"][number];
export const workspaceDefinitions: Record<
  string,
  { label: string; ports: Port[] }
> = {
  ...definitions,
  ...executionDefinitions,
  save: {
    ...definitions.save,
    ports: [
      ...definitions.save.ports,
      { id: "out", direction: "output", type: "image", label: "保存素材" },
    ],
  },
  "image-edit": {
    label: "画像編集",
    ports: [
      { id: "in", direction: "input", type: "image", label: "元画像" },
      { id: "out", direction: "output", type: "image", label: "画像" },
    ],
  },
};
export function parseWorkspace(value: unknown): WorkspaceDocument {
  const doc = workspaceSchema.parse(value),
    accepted = { ...doc, edges: [] as WorkspaceDocument["edges"] };
  for (const edge of doc.edges) {
    const error = connectionError(accepted, edge, workspaceDefinitions);
    if (error) throw new Error(error);
    accepted.edges.push(edge);
  }
  const ids = doc.nodes.flatMap((n) =>
    n.type === "image-edit" ? [n.config.editorDocumentId] : [],
  );
  if (new Set(ids).size !== ids.length)
    throw new Error("編集文書を複数ノードで共有できません");
  return doc;
}
export const inputSchema = z
  .object({
    reference: assetRefSchema,
    layerId: uuid,
    source: z.string().max(128),
  })
  .strict();
export const editorRecordSchema = z
  .object({
    id: uuid,
    document: documentSchema,
    assets: z.record(uuid, assetRefSchema),
    revision: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime(),
    input: inputSchema.optional(),
  })
  .strict();
export type EditorRecord = z.infer<typeof editorRecordSchema>;
export const revisionSchema = editorRecordSchema
  .omit({ revision: true })
  .extend({ editorDocumentId: uuid });
export type EditorRevision = z.infer<typeof revisionSchema>;
export function referencedAssets(doc: ProjectDocument): string[] {
  const ids = new Set(
    doc.pages.flatMap((p) =>
      p.layers.flatMap((l) => (l.kind === "image" ? [l.assetId] : [])),
    ),
  );
  for (const variable of doc.variables.filter((v) => v.type === "image")) {
    for (const value of [variable.default, doc.values[variable.key]])
      if (typeof value === "string" && value) {
        ids.add(uuid.parse(value));
      }
  }
  return [...ids];
}
export function isLegacyNode(node: WorkspaceNode): node is WorkflowNode {
  return node.type !== "image-edit" && !isExecutionNode(node);
}
