import type { MediaVersionRef } from "../../domain/cloud-library/schema";
import type { cloudClient } from "../cloud-library/client";
import { write, MAX_BYTES } from "./storage";
/** Optional import of an existing cloud original. Nothing is uploaded by local encoding. */
export async function cacheCloudSource(
  owner: string,
  ref: MediaVersionRef,
  cloud: ReturnType<typeof cloudClient>,
) {
  const access = await cloud.access(ref.versionId);
  if (!access.ok) throw Error(access.code);
  const response = await fetch(access.data.url);
  if (!response.ok) throw Error("元素材を取得できません。");
  const reader = response.body?.getReader();
  if (!reader) throw Error("元素材を取得できません。");
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw Error("素材は192MiB以下にしてください。");
      parts.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel();
  }
  const blob = new Blob(parts),
    hash = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
      ),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  if (hash !== ref.hash) throw Error("元素材のハッシュが一致しません。");
  let durationUs = 0,
    width = 0,
    height = 0;
  if (ref.kind !== "image") {
    const url = URL.createObjectURL(blob),
      media = document.createElement("video");
    media.preload = "metadata";
    try {
      await new Promise<void>((resolve, reject) => {
        media.onloadedmetadata = () => resolve();
        media.onerror = () =>
          reject(Error("原本のメタデータを読み込めません。"));
        media.src = url;
      });
      durationUs = Math.round(media.duration * 1e6);
      width = media.videoWidth;
      height = media.videoHeight;
      if (
        !Number.isSafeInteger(durationUs) ||
        durationUs <= 0 ||
        (ref.kind === "video" && !width)
      )
        throw Error("原本の長さ・寸法を確認できません。");
    } finally {
      media.removeAttribute("src");
      media.load();
      URL.revokeObjectURL(url);
    }
  }
  await write(owner, `asset:${ref.versionId}`, {
    reference: ref,
    blob,
    durationUs,
    width,
    height,
  });
}
