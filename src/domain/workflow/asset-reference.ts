import { z } from "zod";
import { libraryReferenceSchema } from "../library";
import { assetRefSchema } from "../workspace/schema";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
export const referenceSchema = z.discriminatedUnion("scope", [
  z
    .object({
      scope: z.literal("workspace"),
      reference: assetRefSchema,
      kind: z.literal("image"),
    })
    .strict(),
  z
    .object({
      scope: z.literal("legacy"),
      assetId: key,
      hash,
      kind: z.literal("image"),
    })
    .strict(),
  z
    .object({
      scope: z.literal("execution"),
      outputId: z.string().uuid(),
      hash,
      kind: z.literal("image"),
    })
    .strict(),
  libraryReferenceSchema,
]);

/** Descriptors carry metadata outside the graph. Phase 2 edits images only. */
export type LibraryDescriptor = Readonly<{
  reference: import("./execution").LibraryReference;
  hash: string;
  mime: string;
  size: number;
  dimensions?: Readonly<{ width: number; height: number }>;
  metadata: Readonly<Record<string, string | number | boolean>>;
}>;
/** Committed save result contract; Phase 3 supplies the library handler. */
export type SaveResult =
  | {
      reference: Extract<
        import("./execution").Reference,
        { scope: "workspace" | "library" }
      >;
    }
  | {
      items: readonly Extract<
        import("./execution").Reference,
        { scope: "workspace" | "library" }
      >[];
    };
