import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  ALEO_HASH,
  AV_RENDERER,
  projectNames,
  type AllVersionsProject,
} from "../../../../src/domain/video/all-versions";
import { ApiError } from "../../../api/errors";
export const fontPath = () =>
  resolve(
    process.env.VIDEO_ALEO_FONT ??
      "server/worker/templates/all-versions/assets/Aleo.ttf",
  );
/** Verify on every request/job: an installed substitute or a changed file never passes. */
let registered = false;
async function font() {
  const bytes = await readFile(fontPath()).catch(() => {
    throw new ApiError(503, "FONT_UNAVAILABLE");
  });
  if (createHash("sha256").update(bytes).digest("hex") !== ALEO_HASH)
    throw new ApiError(503, "FONT_UNAVAILABLE");
  if (!registered) {
    if (!GlobalFonts.register(bytes, "AxFluxoAleo"))
      throw new ApiError(503, "FONT_UNAVAILABLE");
    registered = true;
  }
  return bytes;
}
function glyph(bytes: Buffer, cp: number) {
  const tables = bytes.readUInt16BE(4);
  let cmap = 0;
  for (let i = 0; i < tables; i++) {
    const p = 12 + i * 16;
    if (bytes.toString("ascii", p, p + 4) === "cmap")
      cmap = bytes.readUInt32BE(p + 8);
  }
  if (!cmap) return false;
  const count = bytes.readUInt16BE(cmap + 2);
  for (let i = 0; i < count; i++) {
    const base = cmap + bytes.readUInt32BE(cmap + 4 + i * 8 + 4),
      format = bytes.readUInt16BE(base);
    if (format === 12) {
      const groups = bytes.readUInt32BE(base + 12);
      for (let j = 0; j < groups; j++) {
        const p = base + 16 + j * 12,
          start = bytes.readUInt32BE(p),
          end = bytes.readUInt32BE(p + 4);
        if (
          cp >= start &&
          cp <= end &&
          bytes.readUInt32BE(p + 8) + cp - start !== 0
        )
          return true;
      }
    }
    if (format === 4 && cp <= 65535) {
      const n = bytes.readUInt16BE(base + 6) / 2;
      for (let j = 0; j < n; j++) {
        const end = bytes.readUInt16BE(base + 14 + j * 2),
          start = bytes.readUInt16BE(base + 16 + n * 2 + j * 2);
        if (cp < start || cp > end) continue;
        const delta = bytes.readInt16BE(base + 16 + n * 4 + j * 2),
          rangePos = base + 16 + n * 6 + j * 2,
          range = bytes.readUInt16BE(rangePos);
        return range
          ? bytes.readUInt16BE(rangePos + range + (cp - start) * 2) !== 0
          : ((cp + delta) & 65535) !== 0;
      }
    }
  }
  return false;
}
export function dimensions(p: AllVersionsProject) {
  return { width: (p.design.height * 16) / 9, height: p.design.height };
}
export async function textImage(p: AllVersionsProject, index: number) {
  const bytes = await font(),
    text = projectNames(p)[index];
  if (text === undefined || !text.trim()) throw new ApiError(422, "EMPTY_NAME");
  if ([...text].some((c) => !glyph(bytes, c.codePointAt(0)!)))
    throw new ApiError(422, "FONT_GLYPH_UNSUPPORTED");
  const { width, height } = dimensions(p),
    canvas = createCanvas(width, height),
    ctx = canvas.getContext("2d"),
    base = height * 0.085,
    available = width * 0.86;
  ctx.font = `${base}px AxFluxoAleo`;
  const measured = ctx.measureText(text).width,
    size = Math.min(base, (base * available) / Math.max(1, measured));
  ctx.font = `${size}px AxFluxoAleo`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.min(height * 0.004, size * 0.05);
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  ctx.strokeText(text, width / 2, height * 0.855);
  ctx.fillText(text, width / 2, height * 0.855);
  return {
    png: await canvas.encode("png"),
    width,
    height,
    fontHash: ALEO_HASH,
    rendererVersion: AV_RENDERER,
    fontSize: size,
  };
}
export async function backgroundImage(
  p: AllVersionsProject,
  coverPath: string,
) {
  await font();
  const { width, height } = dimensions(p),
    canvas = createCanvas(width, height),
    ctx = canvas.getContext("2d"),
    cover = await loadImage(coverPath);
  const scale = Math.max(width / cover.width, height / cover.height) * 1.12,
    w = cover.width * scale,
    h = cover.height * scale;
  ctx.filter = `blur(${height * 0.035}px)`;
  ctx.drawImage(cover, (width - w) / 2, (height - h) / 2, w, h);
  ctx.filter = "none";
  ctx.fillStyle = "rgba(0,0,0,.3)";
  ctx.fillRect(0, 0, width, height);
  const side = height * 0.56,
    x = (width - side) / 2,
    y = height * 0.12,
    s = Math.max(side / cover.width, side / cover.height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, side, side);
  ctx.clip();
  ctx.drawImage(
    cover,
    x + (side - cover.width * s) / 2,
    y + (side - cover.height * s) / 2,
    cover.width * s,
    cover.height * s,
  );
  ctx.restore();
  ctx.fillStyle = "rgba(0,0,0,.48)";
  ctx.fillRect(width * 0.05, height * 0.78, width * 0.9, height * 0.15);
  return canvas.encode("png");
}
