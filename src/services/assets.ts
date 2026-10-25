import { imageHeaderDimensions } from "./image-header";
import { LIMITS } from "../config/limits";
import { uid } from "../domain/document";
import type { Asset } from "./storage";
export async function sha256(blob: Blob) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export function imageMime(bytes: Uint8Array) {
  if (bytes[0] === 137 && String.fromCharCode(...bytes.slice(1, 4)) === "PNG")
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  throw new Error("PNG / JPEG / 静止WebPのみ対応しています");
}
export async function decodeImage(blob: Blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function importImage(
  file: File,
  normalizedBackup = false,
): Promise<Asset> {
  if (file.size > (normalizedBackup ? LIMITS.archiveBytes : LIMITS.imageBytes))
    throw new Error("画像は20MiB以下にしてください");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = imageMime(bytes);
  const dimensions = imageHeaderDimensions(bytes, mime);
  if (
    dimensions &&
    (!dimensions.width ||
      !dimensions.height ||
      dimensions.width * dimensions.height > LIMITS.imagePixels ||
      Math.max(dimensions.width, dimensions.height) > LIMITS.imageSide)
  )
    throw new Error("画像は24MP・長辺8192px以下にしてください");
  if (mime === "image/png") {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = new DataView(bytes.buffer).getUint32(offset);
      if (
        String.fromCharCode(...bytes.slice(offset + 4, offset + 8)) === "acTL"
      )
        throw new Error("アニメーションPNGには対応していません");
      offset += 12 + length;
    }
  }
  if (
    mime === "image/webp" &&
    String.fromCharCode(
      ...bytes.slice(0, Math.min(bytes.length, 256)),
    ).includes("ANIM")
  )
    throw new Error("アニメーションWebPには対応していません");
  const original = new Blob([bytes], { type: mime });
  const image = await decodeImage(original);
  const width = image.naturalWidth,
    height = image.naturalHeight;
  if (
    width * height > LIMITS.imagePixels ||
    Math.max(width, height) > LIMITS.imageSide
  )
    throw new Error("画像は24MP・長辺8192px以下にしてください");
  const canvas = document.createElement("canvas");
  let blob: Blob;
  try {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("画像変換用のCanvasを確保できません");
    context.drawImage(image, 0, 0);
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) =>
          b ? resolve(b) : reject(new Error("画像の正立変換に失敗しました")),
        "image/png",
      ),
    );
  } finally {
    canvas.width = canvas.height = 0;
  }
  return {
    id: uid(),
    name: file.name,
    width,
    height,
    mime,
    hash: await sha256(blob),
    original,
    blob,
  };
}
