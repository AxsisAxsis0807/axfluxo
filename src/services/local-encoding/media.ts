import type { MediaVersionRef } from "../../domain/cloud-library/schema";
import type { PreviewInfo } from "../../domain/video/preview";
import { asset, read, write, MAX_BYTES, type LocalAsset } from "./storage";
const urls = new Map<string, string[]>();
export function releaseMedia(owner: string) {
  for (const [key, values] of urls)
    if (key.startsWith(`${owner}:`)) {
      values.forEach(URL.revokeObjectURL);
      urls.delete(key);
    }
}
export async function importMedia(
  owner: string,
  file: File,
  kind: MediaVersionRef["kind"],
): Promise<LocalAsset> {
  if (!file.size || file.size > MAX_BYTES)
    throw Error(
      "素材は192MiB以下にしてください。端末のメモリー不足を防ぐための上限です。",
    );
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  const url = URL.createObjectURL(file);
  let width = 0,
    height = 0,
    durationUs = 0;
  try {
    if (kind === "image") {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(Error("画像を読み込めません。"));
        image.src = url;
      });
      width = image.naturalWidth;
      height = image.naturalHeight;
    } else {
      const media = document.createElement("video");
      media.preload = "metadata";
      try {
        await new Promise<void>((resolve, reject) => {
          media.onloadedmetadata = () => resolve();
          media.onerror = () =>
            reject(Error("このブラウザでは素材を読み込めません。"));
          media.src = url;
        });
        durationUs = Math.round(media.duration * 1e6);
        width = media.videoWidth;
        height = media.videoHeight;
        if (
          !Number.isSafeInteger(durationUs) ||
          durationUs <= 0 ||
          (kind === "video" && !width)
        )
          throw Error("素材の長さ・映像を確認できません。");
      } finally {
        media.removeAttribute("src");
        media.load();
      }
    }
  } finally {
    URL.revokeObjectURL(url);
  }
  const id = crypto.randomUUID(),
    reference: MediaVersionRef = {
      libraryId: "local",
      fileId: id,
      versionId: id,
      hash,
      kind,
    };
  const value = { reference, blob: file, durationUs, width, height };
  await write(owner, `asset:${id}`, value);
  return value;
}
export async function localUrl(owner: string, id: string) {
  const key = `${owner}:${id}`;
  if (urls.has(key)) return urls.get(key)![0];
  const row = await asset(owner, id);
  if (!row) throw Error("端末内の素材がありません。原本を再選択してください。");
  const url = URL.createObjectURL(row.blob);
  urls.set(key, [url]);
  return url;
}
export async function localPreview(
  owner: string,
  ref: MediaVersionRef,
): Promise<PreviewInfo> {
  const row = await asset(owner, ref.versionId);
  if (!row || row.reference.hash !== ref.hash) throw Error("SOURCE_MISSING");
  const url = await localUrl(owner, ref.versionId);
  const waveform = await read<Blob>(owner, `waveform:${ref.versionId}`);
  let waveformUrl = "";
  if (waveform) {
    waveformUrl = URL.createObjectURL(waveform);
    urls.get(`${owner}:${ref.versionId}`)!.push(waveformUrl);
  }
  // The existing preview accepts original playback with a zero-offset mapping.
  return {
    versionId: ref.versionId,
    assetId: ref.fileId,
    hash: ref.hash,
    durationUs: row.durationUs,
    width: row.width || 1920,
    height: row.height || 1080,
    mapping: {
      sourceFirstPtsUs: 0,
      proxyFirstPtsUs: 0,
      sourceTimeBase: "1/1000000",
      proxyTimeBase: "1/1000000",
    },
    rate: { numerator: 60, denominator: 1 },
    rotationDegrees: 0,
    proxy: url,
    thumbnail: "",
    waveform: waveformUrl,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

export async function generateWaveform(owner: string, versionId: string) {
  if (!navigator.locks) throw Error("Web Locks対応ブラウザが必要です。");
  const { WasmEngine } = await import("./engine");
  await navigator.locks.request(
    "axfluxo-local-encoder",
    { ifAvailable: true },
    async (lock) => {
      if (!lock) throw Error("書き出し停止後に波形を生成してください。");
      const stop = new AbortController(),
        engine = new WasmEngine();
      const hide = () => {
        if (document.visibilityState !== "visible") {
          stop.abort();
          engine.dispose();
        }
      };
      document.addEventListener("visibilitychange", hide);
      try {
        const wave = await engine.waveform(owner, versionId, stop.signal);
        await write(
          owner,
          `waveform:${versionId}`,
          new Blob([JSON.stringify(wave)], { type: "application/json" }),
        );
      } finally {
        document.removeEventListener("visibilitychange", hide);
        engine.dispose();
      }
    },
  );
}
