import {
  ALEO_HASH,
  projectNames,
  type AllVersionsProject,
} from "../../domain/video/all-versions";
import {
  FNF_FONT_HASH,
  FNF_HEADING,
  type FnfPreferences,
} from "../../domain/video/fnf-showcase";
import { glyph } from "./glyph";
const fontBytes = new Map<string, ArrayBuffer>();
const root = () => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/local-encoding`;
const loaded = new Map<string, Promise<void>>();
async function font(name: string, hash: string, file: string) {
  if (!loaded.has(name))
    loaded.set(
      name,
      (async () => {
        const response = await fetch(`${root()}/${file}`);
        if (!response.ok) throw Error("FONT_UNAVAILABLE");
        const bytes = await response.arrayBuffer();
        const actual = [
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        ]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("");
        if (actual !== hash) throw Error("FONT_UNAVAILABLE");
        fontBytes.set(name, bytes);
        const face = new FontFace(name, bytes);
        await face.load();
        document.fonts.add(face);
      })().catch((e) => {
        loaded.delete(name);
        throw e;
      }),
    );
  await loaded.get(name);
}
function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw Error("Canvasを使用できません。");
  return { c, ctx };
}
const png = (c: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    c.toBlob(
      (b) => (b ? resolve(b) : reject(Error("画像生成に失敗しました。"))),
      "image/png",
    ),
  );
export async function localText(p: AllVersionsProject, index: number) {
  await font("AxFluxoAleo", ALEO_HASH, "Aleo.ttf");
  const h = p.design.height,
    w = (h * 16) / 9,
    { c, ctx } = canvas(w, h),
    text = projectNames(p)[index],
    base = h * 0.085;
  if (
    [...text].some(
      (c) => !glyph(fontBytes.get("AxFluxoAleo")!, c.codePointAt(0)!),
    )
  )
    throw Error("FONT_GLYPH_UNSUPPORTED");
  ctx.font = `${base}px AxFluxoAleo`;
  const size = Math.min(
    base,
    (base * w * 0.86) / Math.max(1, ctx.measureText(text).width),
  );
  ctx.font = `${size}px AxFluxoAleo`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.min(h * 0.004, size * 0.05);
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  ctx.strokeText(text, w / 2, h * 0.855);
  ctx.fillText(text, w / 2, h * 0.855);
  return png(c);
}
export async function localBackground(p: AllVersionsProject, blob: Blob) {
  const h = p.design.height,
    w = (h * 16) / 9,
    { c, ctx } = canvas(w, h),
    url = URL.createObjectURL(blob),
    image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(Error("coverを読み込めません。"));
      image.src = url;
    });
    if (!("filter" in ctx))
      throw Error(
        "このブラウザのCanvasは背景ぼかしに未対応です。対応ブラウザを使用してください。",
      );
    const s = Math.max(w / image.width, h / image.height) * 1.12;
    ctx.filter = `blur(${h * 0.035}px)`;
    ctx.drawImage(
      image,
      (w - image.width * s) / 2,
      (h - image.height * s) / 2,
      image.width * s,
      image.height * s,
    );
    ctx.filter = "none";
    ctx.fillStyle = "rgba(0,0,0,.3)";
    ctx.fillRect(0, 0, w, h);
    const side = h * 0.56,
      x = (w - side) / 2,
      y = h * 0.12,
      scale = Math.max(side / image.width, side / image.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, side, side);
    ctx.clip();
    ctx.drawImage(
      image,
      x + (side - image.width * scale) / 2,
      y + (side - image.height * scale) / 2,
      image.width * scale,
      image.height * scale,
    );
    ctx.restore();
    ctx.fillStyle = "rgba(0,0,0,.48)";
    ctx.fillRect(w * 0.05, h * 0.78, w * 0.9, h * 0.15);
    return png(c);
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function localOverlay(p: FnfPreferences) {
  await font("AxFluxoFnf", FNF_FONT_HASH, "NotoSansJP.ttf");
  const { c, ctx } = canvas(1080, 1920);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  for (const line of [
    { text: FNF_HEADING, size: 37, y: 192 },
    { text: p.username, size: 64, y: 300 },
  ]) {
    ctx.font = `${line.size}px AxFluxoFnf`;
    const size = Math.min(
      line.size,
      (line.size * 1000) / Math.max(1, ctx.measureText(line.text).width),
    );
    ctx.font = `${size}px AxFluxoFnf`;
    ctx.lineWidth = Math.min(4, size * 0.06);
    ctx.strokeText(line.text, 540, line.y);
    ctx.fillText(line.text, 540, line.y);
  }
  return png(c);
}
