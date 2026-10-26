import { z } from "zod";
import { workspaceSchema } from "../workspace/schema";
import { workflowSchema } from "./schema";
import { referenceSchema } from "./asset-reference";
const id = z.string().min(1).max(128),
  uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
// Zod's record parser strips __proto__. Legacy graph IDs can legally contain
// that string, so validate own entries without renaming or losing their keys.
const record = <T extends z.ZodType>(value: T) =>
  z.custom<Record<string, z.output<T>>>(
    (input) =>
      input !== null &&
      typeof input === "object" &&
      (Object.getPrototypeOf(input) === Object.prototype ||
        Object.getPrototypeOf(input) === null) &&
      Object.entries(input).every(
        ([key, entry]) =>
          id.safeParse(key).success && value.safeParse(entry).success,
      ),
    "辞書の形式が不正です",
  );
const state = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "interrupted",
]);
const error = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().max(200),
    nodeId: id.optional(),
  })
  .strict();
const image = z
  .object({
    type: z.literal("image"),
    reference: referenceSchema.refine((ref) => ref.kind === "image"),
    hash,
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    size: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
  })
  .strict();
export const valueSchema = z.discriminatedUnion("type", [
  image,
  z.object({ type: z.literal("text"), value: z.string().max(20000) }).strict(),
  z.object({ type: z.literal("number"), value: z.number().finite() }).strict(),
  z
    .object({
      type: z.literal("file"),
      reference: referenceSchema.refine(
        (ref) => ref.scope === "library" && ref.kind === "file",
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal("collection<image>"),
      items: z.array(image).max(200),
    })
    .strict(),
]);
const outputs = record(valueSchema);
export const attemptSchema = z
  .object({
    id: uuid,
    runId: uuid,
    nodeId: id,
    number: z.number().int().positive(),
    state,
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().optional(),
    cacheHit: z.boolean().optional(),
    error: error.optional(),
  })
  .strict();
export const runSchema = z
  .object({
    id: uuid,
    workflowId: id,
    snapshot: z
      .object({
        graph: z.union([workflowSchema, workspaceSchema]),
        sources: record(image),
        revisions: record(uuid),
        rendererVersion: id,
        fontVersion: id,
        outputSpec: z.literal("png-v1"),
      })
      .strict(),
    policy: z.enum(["stop", "continue"]),
    state,
    createdAt: z.iso.datetime(),
    endedAt: z.iso.datetime().optional(),
    nodes: record(
      z
        .object({
          nodeId: id,
          state,
          attemptIds: z.array(uuid).max(200),
          outputs: outputs.optional(),
          error: error.optional(),
        })
        .strict(),
    ),
    error: error.optional(),
    retryOf: uuid.optional(),
  })
  .strict();
export const cacheEntrySchema = z.object({ id: hash, outputs }).strict();
