import {
  baseLayer,
  defaultCrop,
  newProject,
  type ImageLayer,
} from "../../../domain/document";
import {
  ExecutionError,
  type NodeContext,
  type ImageValue,
  type Output,
} from "../../../domain/workflow/execution";
import { sha256 } from "../../assets";
import { imageValue } from "../asset-resolver";
export async function generated(
  blob: Blob,
  width: number,
  height: number,
  context: NodeContext,
): Promise<ImageValue> {
  context.signal.throwIfAborted();
  if (blob.size > 20 * 1024 * 1024)
    throw new ExecutionError("OUTPUT_LIMIT", "出力画像が20MiBを超えています");
  const output: Output = {
    id: crypto.randomUUID(),
    blob,
    hash: await sha256(blob),
    width,
    height,
    mime: "image/png",
  };
  context.signal.throwIfAborted();
  context.outputs.push(output);
  return imageValue(
    {
      scope: "execution",
      outputId: output.id,
      hash: output.hash,
      kind: "image",
    },
    output,
  );
}
/** Reuse Studio's crop geometry, color filters, font loading and serialized export. */
export async function processImage(
  input: ImageValue,
  operation: "resize" | "crop" | "adjust",
  config: {
    width?: number;
    height?: number;
    brightness?: number;
    contrast?: number;
    saturation?: number;
  },
  context: NodeContext,
) {
  const source = await context.resolver.resolve(
    input.reference,
    context.signal,
  );
  const width = config.width ?? source.width;
  const height =
    config.height ??
    (operation === "crop"
      ? width
      : Math.round((source.height * width) / source.width));
  if (
    width < 64 ||
    height < 64 ||
    Math.max(width, height) > 4096 ||
    width * height > 8_500_000
  )
    throw new ExecutionError(
      "OUTPUT_LIMIT",
      "出力は64〜4096px・8.5MP以内にしてください",
    );
  const doc = newProject("Workflow output"),
    page = doc.pages[0];
  page.width = width;
  page.height = height;
  page.alpha = 0;
  const layer: ImageLayer = {
    ...baseLayer("image"),
    kind: "image",
    assetId: source.id,
    x: width / 2,
    y: height / 2,
    width,
    height,
    crop: {
      ...defaultCrop(),
      mode: operation === "crop" ? "cover" : "contain",
    },
    effects: {
      brightness: config.brightness ?? 1,
      contrast: config.contrast ?? 1,
      saturation: config.saturation ?? 1,
      blur: 0,
    },
  };
  page.layers = [layer];
  const { exportPage } = await import("../../../renderers/scene");
  const blob = await exportPage(
    page,
    doc,
    "png",
    1,
    "#ffffff",
    false,
    async (id) => (id === source.id ? source : undefined),
    context.signal,
  );
  return generated(blob, width, height, context);
}
