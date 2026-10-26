import {
  ExecutionError,
  type Reference,
  type Resolver,
  type Output,
  type ImageValue,
  type LibraryReference,
  type RunRepository,
} from "../../domain/workflow/execution";
import { LIMITS } from "../../config/limits";
import { get, type Asset } from "../storage";
import { read } from "../workspace/db";
import { imageMime, sha256, decodeImage } from "../assets";
import { imageHeaderDimensions } from "../image-header";
import { runRepository } from "./run-repository";
import { referenceSchema } from "../../domain/workflow/asset-reference";
export { referenceSchema } from "../../domain/workflow/asset-reference";
export type LibraryLookup = (
  reference: LibraryReference,
) => Promise<Output | undefined>;
export async function validateImage(
  output: Output,
  expectedHash: string,
  decode = true,
): Promise<void> {
  if (
    !output.blob.size ||
    output.blob.size > LIMITS.imageBytes ||
    !Number.isInteger(output.width) ||
    !Number.isInteger(output.height) ||
    output.width < 1 ||
    output.height < 1 ||
    output.width * output.height > LIMITS.imagePixels ||
    Math.max(output.width, output.height) > LIMITS.imageSide
  )
    throw new ExecutionError(
      "IMAGE_LIMIT",
      "画像の容量または寸法が上限を超えています",
    );
  const bytes = new Uint8Array(await output.blob.arrayBuffer());
  let mime: string;
  try {
    mime = imageMime(bytes);
  } catch {
    throw new ExecutionError("IMAGE_MIME", "画像形式を確認できません");
  }
  const dimensions = imageHeaderDimensions(bytes, mime);
  if (
    mime !== output.mime ||
    output.blob.type !== mime ||
    !dimensions ||
    dimensions.width !== output.width ||
    dimensions.height !== output.height
  )
    throw new ExecutionError(
      "IMAGE_MIME",
      "画像のMIMEまたは寸法が一致しません",
    );
  if (mime === "image/png") {
    const view = new DataView(bytes.buffer);
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (
        String.fromCharCode(...bytes.slice(offset + 4, offset + 8)) === "acTL"
      )
        throw new ExecutionError("IMAGE_ANIMATED", "静止画像のみ実行できます");
      offset += 12 + length;
    }
  }
  if (
    mime === "image/webp" &&
    String.fromCharCode(...bytes.slice(0, 256)).includes("ANIM")
  )
    throw new ExecutionError("IMAGE_ANIMATED", "静止画像のみ実行できます");
  if (
    (await sha256(output.blob)) !== expectedHash ||
    output.hash !== expectedHash
  )
    throw new ExecutionError("ASSET_HASH", "画像参照のhashが一致しません");
  if (decode) {
    const image = await decodeImage(output.blob);
    if (
      image.naturalWidth !== output.width ||
      image.naturalHeight !== output.height
    )
      throw new ExecutionError("IMAGE_DECODE", "画像を正しく復号できません");
  }
}
export function createAssetResolver(
  repository: RunRepository = runRepository,
  library?: LibraryLookup,
): Resolver {
  const resolve: Resolver["resolve"] = async (raw, signal) => {
    signal.throwIfAborted();
    const parsed = referenceSchema.safeParse(raw);
    if (!parsed.success)
      throw new ExecutionError("ASSET_REFERENCE", "素材参照が不正です");
    const reference = parsed.data;
    if (reference.kind !== "image")
      throw new ExecutionError(
        "ASSET_TYPE",
        "file・音声・動画を画像へ暗黙変換できません",
      );
    let output: Output | undefined;
    if (reference.scope === "execution")
      output = await repository.output(reference.outputId);
    else if (reference.scope === "library") output = await library?.(reference);
    else {
      const asset =
        reference.scope === "workspace"
          ? await read<Asset | undefined>("assets", reference.reference.assetId)
          : await get<Asset>("assets", reference.assetId);
      if (asset)
        output = {
          id: asset.id,
          hash: asset.hash,
          blob: asset.blob,
          mime: asset.blob.type,
          width: asset.width,
          height: asset.height,
        };
    }
    if (!output)
      throw new ExecutionError(
        "ASSET_MISSING",
        "固定された素材versionが見つかりません",
      );
    await validateImage(
      output,
      reference.scope === "workspace"
        ? reference.reference.hash
        : reference.hash,
    );
    signal.throwIfAborted();
    return output;
  };
  return {
    resolve,
    async pin(assetId, scope) {
      const asset =
        scope === "workspace"
          ? await read<Asset | undefined>("assets", assetId)
          : await get<Asset>("assets", assetId);
      if (!asset)
        throw new ExecutionError("ASSET_MISSING", "入力素材が見つかりません");
      const reference: Reference =
        scope === "workspace"
          ? { scope, kind: "image", reference: { assetId, hash: asset.hash } }
          : { scope, kind: "image", assetId, hash: asset.hash };
      const output = await resolve(reference, new AbortController().signal);
      return imageValue(reference, output);
    },
  };
}
export function imageValue(reference: Reference, output: Output): ImageValue {
  return {
    type: "image",
    reference,
    hash: output.hash,
    mime: output.mime,
    width: output.width,
    height: output.height,
    size: output.blob.size,
  };
}
