import { z } from "zod";
import fontManifest from "../../public/fonts/manifest.json";
import { zipSync, strToU8, strFromU8, Unzip, UnzipInflate } from "fflate";
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
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("ZIPが途中で切れています");
  const entryCount = view.getUint16(end + 10, true),
    directoryOffset = view.getUint32(end + 16, true),
    directorySize = view.getUint32(end + 12, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== entryCount ||
    entryCount > LIMITS.entries ||
    directoryOffset + directorySize !== end
  )
    throw new Error("未対応または不正なZIP");
  let position = directoryOffset;
  const centralNames = new Set<string>();
  for (let i = 0; i < entryCount; i++) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50)
      throw new Error("ZIP directoryが不正です");
    const flags = view.getUint16(position + 8, true),
      method = view.getUint16(position + 10, true),
      length = view.getUint16(position + 28, true),
      extra = view.getUint16(position + 30, true),
      comment = view.getUint16(position + 32, true);
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      position + 46 + length + extra + comment > end
    )
      throw new Error("未対応のZIP entry");
    const name = strFromU8(
      bytes.subarray(position + 46, position + 46 + length),
    );
    if (centralNames.has(name)) throw new Error("ZIP entry重複");
    centralNames.add(name);
    position += 46 + length + extra + comment;
  }
  if (position !== end) throw new Error("ZIP directoryの長さ不一致");
  if (bytes.length > LIMITS.archiveBytes) throw new Error("ZIPが大きすぎます");
  const names = new Set<string>();
  const result: Record<string, Uint8Array> = {};
  let total = 0,
    count = 0;
  const unzip = new Unzip((file) => {
    if (
      ++count > LIMITS.entries ||
      names.has(file.name) ||
      file.name.startsWith("/") ||
      file.name.includes("\\") ||
      file.name.split("/").some((p) => p === ".." || p === ".") ||
      !/^(document\.json|manifest\.json|assets\/[0-9a-f-]+\.(png|original))$/i.test(
        file.name,
      )
    )
      throw new Error("不正なZIP entry");
    names.add(file.name);
    if (
      file.originalSize !== undefined &&
      file.originalSize > LIMITS.archiveBytes
    )
      throw new Error("ZIP展開量が上限を超えています");
    const chunks: Uint8Array[] = [];
    let length = 0;
    file.ondata = (err, data, final) => {
      if (err) throw err;
      total += data.length;
      length += data.length;
      if (total > LIMITS.archiveBytes)
        throw new Error("ZIP展開量が上限を超えています");
      chunks.push(data);
      if (final) {
        const merged = new Uint8Array(length);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }
        result[file.name] = merged;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 1024)
    unzip.push(
      bytes.subarray(offset, offset + 1024),
      offset + 1024 >= bytes.length,
    );
  if (
    Object.keys(result).length !== names.size ||
    names.size !== centralNames.size ||
    [...names].some((name) => !centralNames.has(name))
  )
    throw new Error("ZIPが途中で切れています");
  return result;
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
