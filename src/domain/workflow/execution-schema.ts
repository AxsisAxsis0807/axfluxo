import { z } from "zod";
import type { Port } from "./schema";
const side = z.number().int().min(64).max(4096);
const configs = {
  number: z.object({ value: z.number().finite() }).strict(),
  "image-adjust": z
    .object({
      brightness: z.number().min(0).max(2),
      contrast: z.number().min(0).max(2),
      saturation: z.number().min(0).max(2),
    })
    .strict(),
  "collection-pack": z.object({}).strict(),
  "collection-order": z.object({ reverse: z.boolean() }).strict(),
  "collection-item": z
    .object({ index: z.number().int().min(0).max(199) })
    .strict(),
  "image-crop": z.object({ width: side, height: side }).strict(),
  "image-resize": z.object({ width: side, height: side }).strict(),
};
export const executionNodeTypes = [
  "number",
  "image-adjust",
  "collection-pack",
  "collection-order",
  "collection-item",
  "image-crop",
  "image-resize",
] as const;
export type ExecutionNodeType = (typeof executionNodeTypes)[number];
export const executionDefaults = {
  number: { value: 0 },
  "image-adjust": { brightness: 1, contrast: 1, saturation: 1 },
  "collection-pack": {},
  "collection-order": { reverse: false },
  "collection-item": { index: 0 },
  "image-crop": { width: 1080, height: 1080 },
  "image-resize": { width: 1080, height: 1080 },
};
export const executionNodeSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(executionNodeTypes),
    typeVersion: z.literal(1),
    position: z
      .object({
        x: z.number().finite().min(-1e6).max(1e6),
        y: z.number().finite().min(-1e6).max(1e6),
      })
      .strict(),
    config: z.union(Object.values(configs)),
  })
  .strict()
  .superRefine((n, ctx) => {
    if (!configs[n.type].safeParse(n.config).success)
      ctx.addIssue({ code: "custom", message: "ノード設定が不正です" });
  });
export type ExecutionNode = z.infer<typeof executionNodeSchema>;
const port = (
  id: string,
  direction: Port["direction"],
  type: Port["type"],
): Port => ({ id, direction, type, label: id });
const imagePorts = [
  port("in", "input", "image"),
  port("out", "output", "image"),
];
export const executionDefinitions: Record<
  ExecutionNodeType,
  { label: string; ports: Port[] }
> = {
  number: { label: "数値入力", ports: [port("number", "output", "number")] },
  "image-adjust": { label: "画像調整", ports: imagePorts },
  "image-crop": { label: "画像クロップ", ports: imagePorts },
  "image-resize": { label: "画像リサイズ", ports: imagePorts },
  "collection-pack": {
    label: "画像をまとめる",
    ports: [
      port("first", "input", "image"),
      port("second", "input", "image"),
      port("out", "output", "collection<image>"),
    ],
  },
  "collection-order": {
    label: "画像順序",
    ports: [
      port("in", "input", "collection<image>"),
      port("out", "output", "collection<image>"),
    ],
  },
  "collection-item": {
    label: "画像を取り出す",
    ports: [
      port("in", "input", "collection<image>"),
      port("out", "output", "image"),
    ],
  },
};
export function newExecutionNode(
  type: ExecutionNodeType,
  position = { x: 80, y: 80 },
): ExecutionNode {
  return {
    id: crypto.randomUUID(),
    type,
    typeVersion: 1,
    position,
    config: structuredClone(executionDefaults[type]),
  };
}
export function isExecutionNode(node: { type: string }): node is ExecutionNode {
  return (executionNodeTypes as readonly string[]).includes(node.type);
}
