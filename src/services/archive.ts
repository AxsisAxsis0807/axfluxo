import { strFromU8, Unzip, UnzipInflate } from "fflate";
import { LIMITS } from "../config/limits";
export function unzipWithPolicy(bytes: Uint8Array, allowed: RegExp) {
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
      !allowed.test(file.name)
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
