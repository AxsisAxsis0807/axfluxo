import { z } from "zod";
import { WORKFLOW_LIMITS } from "../../config/workflow-limits";
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
const point = z
  .object({
    x: z.number().finite().min(-1e6).max(1e6),
    y: z.number().finite().min(-1e6).max(1e6),
  })
  .strict();
export const nodeTypes = ["source", "image", "text", "save", "post"] as const;
export type NodeType = (typeof nodeTypes)[number];
export type PortType =
  | "image"
  | "text"
  | "number"
  | "file"
  | `collection<${"image" | "text" | "number" | "file"}>`;
export type Port = {
  id: string;
  direction: "input" | "output";
  type: PortType;
  label: string;
};
export const definitions: Record<NodeType, { label: string; ports: Port[] }> = {
  source: {
    label: "素材入力",
    ports: [{ id: "image", direction: "output", type: "image", label: "画像" }],
  },
  image: {
    label: "画像処理",
    ports: [
      { id: "in", direction: "input", type: "image", label: "元画像" },
      { id: "out", direction: "output", type: "image", label: "画像" },
    ],
  },
  text: {
    label: "文章",
    ports: [{ id: "text", direction: "output", type: "text", label: "文章" }],
  },
  save: {
    label: "素材を保存",
    ports: [{ id: "image", direction: "input", type: "image", label: "画像" }],
  },
  post: {
    label: "投稿する",
    ports: [
      { id: "image", direction: "input", type: "image", label: "画像" },
      {
        id: "caption",
        direction: "input",
        type: "text",
        label: "キャプション",
      },
    ],
  },
};
const configs = {
  source: z.object({ assetId: id.optional() }).strict(),
  image: z
    .object({
      operation: z.enum(["resize", "crop"]),
      width: z.number().int().min(64).max(8192),
    })
    .strict(),
  text: z
    .object({
      text: z
        .string()
        .max(20000)
        .refine(
          (v) =>
            !/data:image\/[\w.+-]+;[^,\s]*base64,|sb_secret_[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+/i.test(
              v,
            ),
          "画像やトークンは保存できません",
        ),
    })
    .strict(),
  save: z.object({ name: z.string().max(200) }).strict(),
  post: z.object({ mode: z.enum(["draft", "direct"]) }).strict(),
};
export const defaults = {
  source: {},
  image: { operation: "resize", width: 1080 },
  text: { text: "" },
  save: { name: "" },
  post: { mode: "draft" },
} as const;
const nodeSchema = z
  .object({
    id,
    type: z.enum(nodeTypes),
    typeVersion: z.literal(1),
    position: point,
    config: z.union(Object.values(configs)),
  })
  .strict()
  .superRefine((n, ctx) => {
    if (!configs[n.type].safeParse(n.config).success)
      ctx.addIssue({ code: "custom", message: "ノード設定が不正です" });
  });
export const edgeSchema = z
  .object({
    id,
    sourceNodeId: id,
    sourcePortId: id,
    targetNodeId: id,
    targetPortId: id,
  })
  .strict();
export const workflowSchema = z
  .object({
    schemaVersion: z.literal(1),
    workflowId: id,
    name: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    nodes: z.array(nodeSchema).max(WORKFLOW_LIMITS.nodes),
    edges: z.array(edgeSchema).max(WORKFLOW_LIMITS.edges),
  })
  .strict()
  .superRefine((d, ctx) => {
    for (const values of [d.nodes, d.edges])
      if (new Set(values.map((n) => n.id)).size !== values.length)
        ctx.addIssue({ code: "custom", message: "IDが重複しています" });
  });
export const viewportSchema = point
  .extend({ zoom: z.number().min(0.25).max(2) })
  .strict();
export type WorkflowDocument = z.infer<typeof workflowSchema>;
export type WorkflowNode = WorkflowDocument["nodes"][number];
export type WorkflowEdge = z.infer<typeof edgeSchema>;
export type Viewport = z.infer<typeof viewportSchema>;
export function newWorkflow(): WorkflowDocument {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    workflowId: crypto.randomUUID(),
    name: "無題のWorkflow",
    revision: 0,
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
  };
}
export function newNode(
  type: NodeType,
  position = { x: 80, y: 80 },
): WorkflowNode {
  return {
    id: crypto.randomUUID(),
    type,
    typeVersion: 1,
    position,
    config: structuredClone(defaults[type]),
  };
}
