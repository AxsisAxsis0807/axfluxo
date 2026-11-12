import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  ALEO_HASH,
  AV_RENDERER,
  AV_REFERENCE_LAYOUT,
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
    base = height * AV_REFERENCE_LAYOUT.textSize,
    available = height * AV_REFERENCE_LAYOUT.textMaxWidth;
  ctx.font = `${base}px AxFluxoAleo`;
  const measured = ctx.measureText(text).width,
    size = Math.min(base, (base * available) / Math.max(1, measured));
  ctx.font = `${size}px AxFluxoAleo`;
  const textWidth = ctx.measureText(text).width,
    bandWidth = Math.min(
      width,
      textWidth * AV_REFERENCE_LAYOUT.textScaleX +
        height * AV_REFERENCE_LAYOUT.textBandHorizontalPadding,
    ),
    centerY = height * AV_REFERENCE_LAYOUT.textCenterY,
    bandHeight = height * AV_REFERENCE_LAYOUT.textBandHeight;
  // Draw the reference's tight, 60%-black label band WITH the text:
  // both fade together at version boundaries and cannot become misaligned.
  ctx.fillStyle = `rgba(0,0,0,${AV_REFERENCE_LAYOUT.textBandOpacity})`;
  ctx.fillRect(
    (width - bandWidth) / 2,
    centerY - bandHeight / 2,
    bandWidth,
    bandHeight,
  );
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = height * AV_REFERENCE_LAYOUT.textStroke;
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  ctx.save();
  ctx.translate(width / 2, centerY);
  ctx.scale(AV_REFERENCE_LAYOUT.textScaleX, 1);
  ctx.strokeText(text, 0, 0);
  ctx.fillText(text, 0, 0);
  ctx.restore();
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
  // InShot-style maximum-blur backdrop, made from the same cover art.
  // Overscan prevents the blurred edges exposing empty pixels.
  const scale =
      Math.max(width / cover.width, height / cover.height) *
      AV_REFERENCE_LAYOUT.backgroundOverscan,
    w = cover.width * scale,
    h = cover.height * scale;
  ctx.save();
  ctx.filter = `blur(${height * AV_REFERENCE_LAYOUT.backgroundBlur}px)`;
  ctx.drawImage(cover, (width - w) / 2, (height - h) / 2, w, h);
  ctx.restore();
  // Reference: centered square cover fills the video height, with soft corners.
  const side = height * AV_REFERENCE_LAYOUT.coverSide,
    x = (width - side) / 2,
    y = (height - side) / 2,
    radius = side * AV_REFERENCE_LAYOUT.coverCornerRadius,
    crop = Math.min(cover.width, cover.height);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + side - radius, y);
  ctx.quadraticCurveTo(x + side, y, x + side, y + radius);
  ctx.lineTo(x + side, y + side - radius);
  ctx.quadraticCurveTo(x + side, y + side, x + side - radius, y + side);
  ctx.lineTo(x + radius, y + side);
  ctx.quadraticCurveTo(x, y + side, x, y + side - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(
    cover,
    (cover.width - crop) / 2,
    (cover.height - crop) / 2,
    crop,
    crop,
    x,
    y,
    side,
    side,
  );
  ctx.restore();
  // The tight label band is part of the matching text PNG, not the backdrop.
  return canvas.encode("png");
}
