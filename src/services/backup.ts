import { z } from "zod";
import fontManifest from "../../public/fonts/manifest.json";
import { zipSync, strToU8, strFromU8 } from "fflate";
import { unzipWithPolicy } from "./archive";
import { LIMITS } from "../config/limits";
import {
  documentSchema,
  cloneProject,
  type ProjectDocument,
} from "../domain/document";
import { get, put, type Asset } from "./storage";
import { sha256, importImage } from "./assets";
function assetIds(d: ProjectDocument) {
  const ids = new Set(
    d.pages.flatMap((p) =>
      p.layers.flatMap((l) => (l.kind === "image" ? [l.assetId] : [])),
    ),
  );
  for (const v of d.variables.filter((v) => v.type === "image")) {
    const value = d.values[v.key] ?? v.default;
    if (typeof value === "string" && value) ids.add(value);
  }
  return [...ids];
}
export async function backup(d: ProjectDocument) {
  const entries: Record<string, Uint8Array> = {
    "document.json": strToU8(JSON.stringify(d)),
  };
  const assets = [];
  for (const id of assetIds(d)) {
    const asset = await get<Asset>("assets", id);
    if (!asset) throw new Error("画像が見つかりません");
    entries[`assets/${id}.png`] = new Uint8Array(
      await asset.blob.arrayBuffer(),
    );
    entries[`assets/${id}.original`] = new Uint8Array(
      await asset.original.arrayBuffer(),
    );
    assets.push({
      id,
      name: asset.name,
      hash: asset.hash,
      originalHash: await sha256(asset.original),
      mime: asset.mime,
    });
  }
  entries["manifest.json"] = strToU8(
    JSON.stringify({ version: 1, assets, fonts: fontManifest }),
  );
  if (
    Object.values(entries).reduce((n, bytes) => n + bytes.length, 0) >
    LIMITS.archiveBytes
  )
    throw new Error("バックアップ合計が200MiBを超えています");
  return new Blob([zipSync(entries) as Uint8Array<ArrayBuffer>], {
    type: "application/zip",
  });
}
export function safeUnzip(bytes: Uint8Array) {
  return unzipWithPolicy(
    bytes,
    /^(document\.json|manifest\.json|assets\/[0-9a-f-]+\.(png|original))$/i,
  );
}
export async function restore(file: File) {
  if (file.size > LIMITS.archiveBytes)
    throw new Error("ZIPは200MiB以下にしてください");
  const entries = await safeUnzip(new Uint8Array(await file.arrayBuffer()));
  if (
    !entries["document.json"] ||
    !entries["manifest.json"] ||
    entries["document.json"].length > LIMITS.jsonBytes ||
    entries["manifest.json"].length > LIMITS.jsonBytes
  )
    throw new Error("バックアップ形式が不正です");
  const data = JSON.parse(strFromU8(entries["document.json"]));
  const depth = (v: unknown, n = 0): void => {
    if (n > 32) throw new Error("JSONが深すぎます");
    if (v && typeof v === "object")
      Object.values(v).forEach((x) => depth(x, n + 1));
  };
  depth(data);
  const d = documentSchema.parse(data);
  const hash = z.string().regex(/^[0-9a-f]{64}$/);
  const manifest = z
    .object({
      version: z.literal(1),
      assets: z
        .array(
          z
            .object({
              id: z.string().uuid(),
              name: z.string().max(1024),
              hash,
              originalHash: hash,
              mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
            })
            .strict(),
        )
        .max(LIMITS.entries),
      fonts: z
        .array(
          z
            .object({
              id: z.string(),
              family: z.string(),
              weight: z.number(),
              file: z.string(),
              sha256: hash,
            })
            .strict(),
        )
        .length(fontManifest.length),
    })
    .strict()
    .parse(JSON.parse(strFromU8(entries["manifest.json"])));
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length > LIMITS.entries
  )
    throw new Error("manifestが不正です");
  if (
    !Array.isArray(manifest.fonts) ||
    new Set(manifest.fonts.map((f) => f.file)).size !== fontManifest.length ||
    manifest.fonts.some((font: unknown) => {
      if (!font || typeof font !== "object") return true;
      const f = font as {
        id: string;
        file: string;
        sha256: string;
        weight: number;
      };
      return !fontManifest.some(
        (known) =>
          known.id === f.id &&
          known.file === f.file &&
          known.weight === f.weight &&
          known.sha256 === f.sha256,
      );
    })
  )
    throw new Error("フォント参照またはバージョンが一致しません");
  const assets: Asset[] = [];
  const seen = new Set<string>();
  for (const item of manifest.assets) {
    if (
      !/^[0-9a-f-]{36}$/i.test(item.id) ||
      seen.has(item.id) ||
      typeof item.name !== "string"
    )
      throw new Error("asset IDが不正です");
    seen.add(item.id);
    const image = entries[`assets/${item.id}.png`],
      original = entries[`assets/${item.id}.original`];
    if (!image || !original) throw new Error("画像が不足しています");
    const blob = new Blob([image as Uint8Array<ArrayBuffer>], {
      type: "image/png",
    });
    const originalBlob = new Blob([original as Uint8Array<ArrayBuffer>]);
    if (
      (await sha256(blob)) !== item.hash ||
      (await sha256(originalBlob)) !== item.originalHash
    )
      throw new Error("画像hashが一致しません");
    const validated = await importImage(
      new File([image as Uint8Array<ArrayBuffer>], item.name, {
        type: "image/png",
      }),
      true,
    );
    await importImage(
      new File([original as Uint8Array<ArrayBuffer>], item.name),
    );
    const existing = await get<Asset>("assets", item.id);
    if (existing && existing.hash !== item.hash)
      throw new Error("既存画像IDとの衝突");
    assets.push({
      ...validated,
      id: item.id,
      hash: item.hash,
      blob,
      original: originalBlob,
      mime: item.mime,
    });
  }
  if (assetIds(d).some((id) => !seen.has(id)))
    throw new Error("画像参照が不足しています");
  for (const asset of assets) await put("assets", asset);
  return cloneProject(d);
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export function zipImages(files: Record<string, Uint8Array>) {
  return new Blob([zipSync(files) as Uint8Array<ArrayBuffer>], {
    type: "application/zip",
  });
}
