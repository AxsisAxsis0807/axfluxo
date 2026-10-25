import fontManifest from "../../../public/fonts/manifest.json";
import { exportPage } from "../../renderers/scene";
import { sha256, decodeImage } from "../assets";
import { requiredMissing } from "../../domain/document";
import type { EditorRevision } from "../../domain/workspace/schema";
import { resolverFor, type Artifact } from "../workspace/repository";
export async function imageEditRenderKey(
  revision: EditorRevision,
  pageId: string,
) {
  const page = revision.document.pages.find((p) => p.id === pageId);
  if (!page) throw new Error("出力ページが見つかりません");
  return sha256(
    new Blob([
      JSON.stringify({
        revision: revision.id,
        input: revision.input?.reference.hash,
        pageId,
        format: "png",
        quality: 1,
        background: [page.background, page.alpha],
        fonts: fontManifest,
        renderVersion: 1,
      }),
    ]),
  );
}
let active = false;
export async function renderImageEdit(
  revision: EditorRevision,
  pageId: string,
  signal: AbortSignal,
): Promise<Artifact> {
  if (active)
    throw new Error(
      "別の画像を生成中です。完了またはキャンセル後に再試行してください",
    );
  active = true;
  try {
    signal.throwIfAborted();
    const page = revision.document.pages.find((p) => p.id === pageId);
    if (!page) throw new Error("出力ページが見つかりません");
    if (requiredMissing(revision.document).length)
      throw new Error("必須変数を入力してください");
    const resolver = await resolverFor(revision);
    signal.throwIfAborted();
    const key = await imageEditRenderKey(revision, pageId);
    const blob = await exportPage(
      page,
      revision.document,
      "png",
      1,
      "#ffffff",
      false,
      resolver,
      signal,
    );
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 160 / page.width, 160 / page.height);
    canvas.width = Math.max(1, Math.round(page.width * scale));
    canvas.height = Math.max(1, Math.round(page.height * scale));
    let thumbnail: Blob;
    try {
      canvas
        .getContext("2d")!
        .drawImage(await decodeImage(blob), 0, 0, canvas.width, canvas.height);
      thumbnail = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("サムネイル生成失敗"))),
          "image/png",
        ),
      );
    } finally {
      canvas.width = canvas.height = 0;
    }
    signal.throwIfAborted();
    return {
      id: crypto.randomUUID(),
      key,
      revisionId: revision.id,
      pageId,
      blob,
      hash: await sha256(blob),
      width: page.width,
      height: page.height,
      format: "png",
      thumbnail,
    };
  } finally {
    active = false;
  }
}
