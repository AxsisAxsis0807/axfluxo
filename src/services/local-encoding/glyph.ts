export function glyph(buffer: ArrayBuffer, cp: number) {
  const bytes = new DataView(buffer);
  const tables = bytes.getUint16(4);
  let cmap = 0;
  for (let i = 0; i < tables; i++) {
    const p = 12 + i * 16;
    if (new TextDecoder().decode(new Uint8Array(buffer, p, 4)) === "cmap")
      cmap = bytes.getUint32(p + 8);
  }
  if (!cmap) return false;
  const count = bytes.getUint16(cmap + 2);
  for (let i = 0; i < count; i++) {
    const base = cmap + bytes.getUint32(cmap + 4 + i * 8 + 4),
      format = bytes.getUint16(base);
    if (format === 12) {
      const groups = bytes.getUint32(base + 12);
      for (let j = 0; j < groups; j++) {
        const p = base + 16 + j * 12,
          start = bytes.getUint32(p),
          end = bytes.getUint32(p + 4);
        if (
          cp >= start &&
          cp <= end &&
          bytes.getUint32(p + 8) + cp - start !== 0
        )
          return true;
      }
    }
    if (format === 4 && cp <= 65535) {
      const n = bytes.getUint16(base + 6) / 2;
      for (let j = 0; j < n; j++) {
        const end = bytes.getUint16(base + 14 + j * 2),
          start = bytes.getUint16(base + 16 + n * 2 + j * 2);
        if (cp < start || cp > end) continue;
        const delta = bytes.getInt16(base + 16 + n * 4 + j * 2),
          rangePos = base + 16 + n * 6 + j * 2,
          range = bytes.getUint16(rangePos);
        return range
          ? bytes.getUint16(rangePos + range + (cp - start) * 2) !== 0
          : ((cp + delta) & 65535) !== 0;
      }
    }
  }
  return false;
}
