import { workspaceDefinitions } from "../../domain/workspace/schema";
import {
  ExecutionError,
  type NodeDefinition,
  type NodeContext,
  type ImageValue,
  type Graph,
} from "../../domain/workflow/execution";
import { processImage, generated } from "./nodes/image";
import { loadRevision } from "../workspace/repository";
export type Registry = ReadonlyMap<string, NodeDefinition>;
const inputImage = (context: NodeContext) => {
  const value = context.inputs.in;
  if (value?.type !== "image")
    throw new ExecutionError("INPUT_TYPE", "画像入力が必要です");
  return value;
};
export function createRegistry(): Registry {
  const registry = new Map<string, NodeDefinition>();
  const add = (
    type: string,
    required: NodeDefinition["required"],
    execute: NodeDefinition["execute"],
  ) =>
    registry.set(`${type}@1`, {
      pure: true,
      ports: workspaceDefinitions[type].ports,
      required,
      execute,
    });
  add("source", [], async (node, context) => ({
    image: context.snapshot.sources[node.id],
  }));
  add("text", [], async (node) => ({
    text: {
      type: "text",
      value: "text" in node.config ? node.config.text : "",
    },
  }));
  add("number", [], async (node) => ({
    number: {
      type: "number",
      value: "value" in node.config ? node.config.value : 0,
    },
  }));
  for (const type of ["image", "image-crop", "image-resize", "image-adjust"]) {
    add(type, ["in"], async (node, context) => {
      const config = node.config;
      const operation =
        type === "image-adjust"
          ? "adjust"
          : type === "image-crop"
            ? "crop"
            : type === "image" && "operation" in config
              ? config.operation
              : "resize";
      return {
        out: await processImage(
          inputImage(context),
          operation,
          {
            width: "width" in config ? config.width : undefined,
            height: "height" in config ? config.height : undefined,
            brightness: "brightness" in config ? config.brightness : undefined,
            contrast: "contrast" in config ? config.contrast : undefined,
            saturation: "saturation" in config ? config.saturation : undefined,
          },
          context,
        ),
      };
    });
  }
  for (const type of ["image", "image-crop", "image-resize"]) {
    const entry = registry.get(`${type}@1`)!;
    registry.set(`${type}@1`, {
      ...entry,
      validate: (node) => {
        const config = node.config;
        if (
          "width" in config &&
          (config.width > 4096 ||
            ("height" in config && config.width * config.height > 8_500_000))
        )
          throw new ExecutionError(
            "OUTPUT_LIMIT",
            "出力は4096px・8.5MP以内にしてください",
            node.id,
          );
      },
    });
  }
  add("collection-pack", ["first", "second"], async (_node, context) => ({
    out: {
      type: "collection<image>",
      items: [context.inputs.first, context.inputs.second] as ImageValue[],
    },
  }));
  add("collection-order", ["in"], async (node, context) => {
    const value = context.inputs.in;
    if (value?.type !== "collection<image>")
      throw new ExecutionError("INPUT_TYPE", "画像collectionが必要です");
    return {
      out: {
        ...value,
        items:
          "reverse" in node.config && node.config.reverse
            ? [...value.items].reverse()
            : [...value.items],
      },
    };
  });
  add("collection-item", ["in"], async (node, context) => {
    const value = context.inputs.in,
      index = "index" in node.config ? node.config.index : -1;
    if (value?.type !== "collection<image>" || !value.items[index])
      throw new ExecutionError(
        "COLLECTION_INDEX",
        "指定されたcollection要素がありません",
      );
    return { out: value.items[index] };
  });
  add(
    "image-edit",
    (node) =>
      node.type === "image-edit" && node.config.inputMode === "connected"
        ? ["in"]
        : [],
    async (node, context) => {
      if (node.type !== "image-edit")
        throw new ExecutionError("NODE_TYPE", "ノードが不正です");
      const revision = await loadRevision(context.snapshot.revisions[node.id]);
      // Applied v1 revisions have a fixed input. Never silently replace an edited layer.
      if (node.config.inputMode === "connected") {
        const input = inputImage(context);
        if (!revision.input || input.hash !== revision.input.reference.hash)
          throw new ExecutionError(
            "EDIT_INPUT_CHANGED",
            "入力が適用済み編集版と異なります。画像編集で差し替えて適用してください",
          );
      }
      const { renderImageEdit } = await import("../editor/render-image-edit");
      const artifact = await renderImageEdit(
        revision,
        node.config.outputPageId!,
        context.signal,
      );
      return {
        out: await generated(
          artifact.blob,
          artifact.width,
          artifact.height,
          context,
        ),
      };
    },
  );
  return registry;
}
export function definition(
  registry: Registry,
  node: Graph["nodes"][number],
): NodeDefinition {
  const value = registry.get(`${node.type}@${node.typeVersion}`);
  if (!value)
    throw new ExecutionError(
      "UNSUPPORTED_NODE",
      "このノードはPhase 2では実行できません",
      node.id,
    );
  return value;
}
