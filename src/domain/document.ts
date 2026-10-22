import { z } from "zod";
import { LIMITS } from "../config/limits";
const n = z.number().finite();
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
export const keySchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine(
    (k) =>
      ![
        "__proto__",
        "prototype",
        "constructor",
        "toString",
        "valueOf",
      ].includes(k),
    "予約語は使用できません",
  );
export const cropSchema = z
  .object({
    version: z.literal(1),
    shape: z.enum(["rect", "ellipse"]),
    mode: z.enum(["cover", "contain"]),
    focus: z.object({ u: n.min(0).max(1), v: n.min(0).max(1) }),
    zoom: n.min(0.05).max(20),
    rotation: n.min(-360).max(360),
  })
  .strict();
const common = {
  id: z.string().uuid(),
  name: z.string().max(200),
  x: n,
  y: n,
  width: n.positive().max(16384),
  height: n.positive().max(16384),
  rotation: n.min(-360).max(360),
  opacity: n.min(0).max(1),
  visible: z.boolean(),
  locked: z.boolean(),
};
const binding = z
  .object({
    key: keySchema,
    prefix: z.string().max(500),
    suffix: z.string().max(500),
  })
  .strict();
export const layerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("image"),
      assetId: z.string().uuid(),
      crop: cropSchema,
      effects: z
        .object({
          brightness: n.min(0).max(2),
          contrast: n.min(0).max(2),
          saturation: n.min(0).max(2),
          blur: n.min(0).max(40),
        })
        .strict(),
      imageBinding: keySchema.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("text"),
      text: z.string().max(20000),
      textBinding: binding.optional(),
      fontId: z.enum(["noto", "inter", "lora"]),
      fontWeight: z.enum(["400", "700"]),
      fontSize: n.min(8).max(512),
      color,
      lineHeight: n.min(0.5).max(4),
      letterSpacing: n.min(-10).max(100),
      align: z.enum(["left", "center", "right"]),
      overflow: z.enum(["warn", "shrink"]),
      minFontSize: n.min(8).max(512),
      background: z
        .object({
          mode: z.enum(["none", "box", "line"]),
          color,
          alpha: n.min(0).max(1),
          padding: n.min(0).max(100),
          radius: n.min(0).max(200),
        })
        .strict(),
      stroke: z.object({ color, width: n.min(0).max(20) }).strict(),
      shadow: z
        .object({ color, blur: n.min(0).max(40), offset: n.min(0).max(40) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("shape"),
      shape: z.enum(["rect", "ellipse", "line"]),
      fill: color,
      fillAlpha: n.min(0).max(1),
      stroke: color,
      strokeWidth: n.min(0).max(100),
      radius: n.min(0).max(2048),
    })
    .strict(),
]);
export const pageSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().max(200),
    width: n.min(64).max(LIMITS.pageSide),
    height: n.min(64).max(LIMITS.pageSide),
    background: color,
    alpha: n.min(0).max(1),
    layers: z.array(layerSchema).max(LIMITS.layers),
  })
  .strict()
  .refine(
    (p) => p.width * p.height <= LIMITS.pagePixels,
    "ページ面積が上限を超えています",
  );
export const variableSchema = z
  .object({
    key: keySchema,
    label: z.string().max(200),
    type: z.enum(["string", "number", "image"]),
    required: z.boolean(),
    default: z.union([z.string().max(20000), n]).optional(),
    validation: z
      .object({
        maxLength: n.int().min(1).max(20000).optional(),
        min: n.optional(),
        max: n.optional(),
      })
      .strict()
      .refine(
        (v) => v.min === undefined || v.max === undefined || v.min <= v.max,
        "数値範囲が逆です",
      )
      .optional(),
  })
  .strict();
export const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    revision: n.int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    pages: z.array(pageSchema).min(1).max(LIMITS.pages),
    variables: z.array(variableSchema).max(100),
    values: z.record(keySchema, z.union([z.string().max(20000), n])),
    templateOrigin: z
      .object({ id: z.string().uuid(), version: n.int().positive() })
      .strict()
      .optional(),
    caption: z.string().max(20000),
    hashtags: z.string().max(2000),
  })
  .strict()
  .superRefine((d, ctx) => {
    const ids = [
      ...d.pages.map((p) => p.id),
      ...d.pages.flatMap((p) => p.layers.map((l) => l.id)),
    ];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "ID重複" });
    if (new Set(d.variables.map((v) => v.key)).size !== d.variables.length)
      ctx.addIssue({ code: "custom", message: "変数キー重複" });
    for (const page of d.pages)
      for (const l of page.layers) {
        const key =
          l.kind === "text"
            ? l.textBinding?.key
            : l.kind === "image"
              ? l.imageBinding
              : undefined;
        if (key) {
          const v = d.variables.find((v) => v.key === key);
          if (
            !v ||
            (l.kind === "image" && v.type !== "image") ||
            (l.kind === "text" && v.type === "image")
          )
            ctx.addIssue({ code: "custom", message: "変数参照が不正です" });
        }
      }
    for (const v of d.variables) {
      const value = d.values[v.key] ?? v.default;
      if (
        typeof value === "string" &&
        v.validation?.maxLength !== undefined &&
        value.length > v.validation.maxLength
      )
        ctx.addIssue({
          code: "custom",
          message: v.label + "は文字数制限を超えています",
        });
      if (
        typeof value === "number" &&
        ((v.validation?.min !== undefined && value < v.validation.min) ||
          (v.validation?.max !== undefined && value > v.validation.max))
      )
        ctx.addIssue({
          code: "custom",
          message: v.label + "は数値範囲を超えています",
        });
      if (
        v.type === "image" &&
        value !== undefined &&
        value !== "" &&
        !z.string().uuid().safeParse(value).success
      )
        ctx.addIssue({
          code: "custom",
          message: "画像変数はasset IDで指定してください",
        });
      if (
        value !== undefined &&
        ((v.type === "number" && typeof value !== "number") ||
          (v.type !== "number" && typeof value !== "string"))
      )
        ctx.addIssue({ code: "custom", message: "変数型不一致" });
    }
  });
export type ProjectDocument = z.infer<typeof documentSchema>;
export type Page = z.infer<typeof pageSchema>;
export type Layer = z.infer<typeof layerSchema>;
export type ImageLayer = Extract<Layer, { kind: "image" }>;
export type TextLayer = Extract<Layer, { kind: "text" }>;
export type Crop = z.infer<typeof cropSchema>;
export const uid = () => crypto.randomUUID();
export const defaultCrop = (): Crop => ({
  version: 1,
  shape: "rect",
  mode: "cover",
  focus: { u: 0.5, v: 0.5 },
  zoom: 1,
  rotation: 0,
});
export function newPage(): Page {
  return {
    id: uid(),
    name: "ページ",
    width: 1080,
    height: 1080,
    background: "#16191f",
    alpha: 1,
    layers: [],
  };
}
export function newProject(name = "無題のプロジェクト"): ProjectDocument {
  const date = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: uid(),
    name,
    revision: 0,
    createdAt: date,
    updatedAt: date,
    pages: [newPage()],
    variables: [],
    values: {},
    caption: "",
    hashtags: "",
  };
}
export function baseLayer(kind: Layer["kind"]) {
  return {
    id: uid(),
    name: kind === "text" ? "テキスト" : kind === "image" ? "画像" : "図形",
    x: 540,
    y: 540,
    width: 600,
    height: 200,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
  };
}
export function newText(): TextLayer {
  return {
    ...baseLayer("text"),
    kind: "text",
    text: "あなたのアイデアを、かたちに。",
    fontId: "noto",
    fontWeight: "700",
    fontSize: 48,
    color: "#ffffff",
    lineHeight: 1.4,
    letterSpacing: 0,
    align: "center",
    overflow: "warn",
    minFontSize: 16,
    background: {
      mode: "line",
      color: "#000000",
      alpha: 0.7,
      padding: 16,
      radius: 12,
    },
    stroke: { color: "#000000", width: 0 },
    shadow: { color: "#000000", blur: 0, offset: 0 },
  };
}
export function cloneProject(
  d: ProjectDocument,
  origin?: { id: string; version: number },
): ProjectDocument {
  const c = structuredClone(d);
  const date = new Date().toISOString();
  return {
    ...c,
    id: uid(),
    revision: 0,
    createdAt: date,
    updatedAt: date,
    templateOrigin: origin ?? c.templateOrigin,
    pages: c.pages.map((p) => ({
      ...p,
      id: uid(),
      layers: p.layers.map((l) => ({ ...l, id: uid() })),
    })),
  };
}
export function resolveText(l: TextLayer, d: ProjectDocument) {
  if (!l.textBinding) return l.text;
  const b = l.textBinding;
  const v =
    d.values[b.key] ?? d.variables.find((v) => v.key === b.key)?.default;
  return v === undefined ? "" : b.prefix + String(v) + b.suffix;
}
export function resolveAsset(l: ImageLayer, d: ProjectDocument) {
  return l.imageBinding
    ? String(
        d.values[l.imageBinding] ??
          d.variables.find((v) => v.key === l.imageBinding)?.default ??
          l.assetId,
      )
    : l.assetId;
}
export function requiredMissing(d: ProjectDocument) {
  return d.variables
    .filter((v) => v.required && (d.values[v.key] ?? v.default ?? "") === "")
    .map((v) => v.label);
}
export type History = {
  past: ProjectDocument[];
  present: ProjectDocument;
  future: ProjectDocument[];
};
export type Action =
  | { type: "commit"; document: ProjectDocument; at?: string }
  | { type: "undo"; at?: string }
  | { type: "redo"; at?: string }
  | { type: "load"; document: ProjectDocument };
export function reducer(h: History, a: Action): History {
  if (a.type === "load")
    return { past: [], present: documentSchema.parse(a.document), future: [] };
  if (a.type === "commit") {
    const d = documentSchema.parse(a.document);
    return {
      past: [...h.past, h.present].slice(-LIMITS.history),
      present: {
        ...d,
        revision: h.present.revision + 1,
        updatedAt: a.at ?? h.present.updatedAt,
      },
      future: [],
    };
  }
  const source = a.type === "undo" ? h.past : h.future;
  if (!source.length) return h;
  const next = source[source.length - 1];
  return {
    past: a.type === "undo" ? h.past.slice(0, -1) : [...h.past, h.present],
    present: {
      ...next,
      revision: h.present.revision + 1,
      updatedAt: a.at ?? h.present.updatedAt,
    },
    future:
      a.type === "undo" ? [...h.future, h.present] : h.future.slice(0, -1),
  };
}
