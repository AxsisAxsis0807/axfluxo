import {
  ALL_VERSIONS_COVER_RADIUS_RATIO,
  ALL_VERSIONS_REFERENCE as REF,
  REFERENCE_BACKGROUND,
  referenceOpacity,
  referenceTimerText,
  referenceTitleSize,
  type VersionWindow,
} from "../../domain/video/all-versions-reference";

import {
  COVER_BLUR_HEIGHT,
  COVER_BLUR_WIDTH,
  drawCoverBackground,
} from "../../domain/video/cover-background";
import { imageForEncode } from "./local-encode";

export function drawAllVersionsCover(
  ctx: CanvasRenderingContext2D,
  cover: HTMLImageElement,
  x: number,
  y: number,
  side: number,
) {
  const crop = Math.min(cover.width, cover.height);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, side, side, side * ALL_VERSIONS_COVER_RADIUS_RATIO);
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
}

export async function referenceArtwork(
  cover: HTMLImageElement | null,
  width: number,
  height: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw Error("Canvasを使用できません。");

  if (cover) {
    const backdrop = document.createElement("canvas");
    backdrop.width = COVER_BLUR_WIDTH;
    backdrop.height = COVER_BLUR_HEIGHT;
    const backdropContext = backdrop.getContext("2d", { alpha: false });
    if (!backdropContext) throw Error("Canvasを使用できません。");
    drawCoverBackground<CanvasImageSource, ImageData>(
      ctx,
      backdropContext,
      backdrop,
      width,
      height,
      cover,
      cover.naturalWidth,
      cover.naturalHeight,
    );
  } else {
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    const fallback = await imageForEncode(`${basePath}/${REFERENCE_BACKGROUND}`);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(fallback, 0, 0, width, height);
  }
  return canvas;
}

let referenceFonts: Promise<void> | undefined;
export async function loadReferenceFonts(labels: readonly string[]) {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  referenceFonts ??= Promise.all([
    new FontFace("AxFluxoAleo", `url(${basePath}/fonts/Aleo.ttf)`).load(),
    new FontFace(
      "AxFluxoClock",
      `url(${basePath}/fonts/ReferenceClock.ttf)`,
    ).load(),
  ])
    .then((fonts) => {
      for (const font of fonts) document.fonts.add(font);
    })
    .catch((error: unknown) => {
      referenceFonts = undefined;
      throw error;
    });
  const japanese = [...new Set(labels.join(""))]
    .filter((character) =>
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f]/u.test(
        character,
      ),
    )
    .join("");
  await Promise.all([
    referenceFonts,
    japanese && document.fonts.load('400 16px "Ax Noto"', japanese),
  ]);
}

export function referenceCanvasTitle(labels: readonly string[]) {
  // Reuse a single small strip, including on seeks and version switches.
  const strip = document.createElement("canvas");
  let lastIndex = -1;
  let lastWidth = 0;
  let lastHeight = 0;
  return (ctx: CanvasRenderingContext2D, index: number) => {
    const text = labels[index];
    if (!text?.trim()) return;
    const { width, height } = ctx.canvas;
    const scale = height / REF.height;
    if (index !== lastIndex || width !== lastWidth || height !== lastHeight) {
      const title = strip.getContext("2d");
      if (!title) throw Error("Canvasを使用できません。");
      const base = REF.titleFontSize * scale;
      const font = (size: number) => `${size}px AxFluxoAleo, "Ax Noto", serif`;
      title.font = font(base);
      const size = referenceTitleSize(
        base,
        width,
        title.measureText(text).width,
      );
      title.font = font(size);
      strip.width = Math.ceil(
        title.measureText(text).width + REF.titleBandPadding * scale,
      );
      strip.height = Math.ceil(REF.titleBandHeight * scale);
      title.fillStyle = `rgba(0,0,0,${REF.titleBandAlpha})`;
      title.fillRect(0, 0, strip.width, strip.height);
      title.font = font(size);
      title.textAlign = "center";
      title.textBaseline = "middle";
      title.lineJoin = "round";
      title.lineWidth = Math.max(1, size * REF.titleStrokeRatio);
      title.strokeStyle = "black";
      title.fillStyle = "white";
      title.strokeText(text, strip.width / 2, strip.height / 2);
      title.fillText(text, strip.width / 2, strip.height / 2);
      lastIndex = index;
      lastWidth = width;
      lastHeight = height;
    }
    ctx.drawImage(
      strip,
      Math.round((width - strip.width) / 2),
      Math.round(REF.titleBandTop * scale),
    );
  };
}

export function drawReferenceFrame(
  ctx: CanvasRenderingContext2D,
  artwork: HTMLCanvasElement,
  frame: number,
  versions: readonly VersionWindow[],
  design: { fadeInFrames: number; fadeOutFrames: number },
  drawTitle: (ctx: CanvasRenderingContext2D, index: number) => void,
) {
  const { width, height } = ctx.canvas;
  ctx.drawImage(artwork, 0, 0, width, height);
  const index = versions.findIndex(
    (v) => frame >= v.startFrame && frame < v.endFrame,
  );
  if (index < 0) return;
  const version = versions[index];
  const opacity = (track: "title" | "timer") =>
    referenceOpacity(
      frame,
      version,
      design.fadeInFrames,
      design.fadeOutFrames,
      track,
    );
  ctx.save();
  ctx.globalAlpha = opacity("title");
  drawTitle(ctx, index);
  ctx.globalAlpha = opacity("timer");
  ctx.fillStyle = "white";
  ctx.font = `${(height * REF.timerFontSize) / REF.height}px AxFluxoClock, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(
    referenceTimerText(frame, version),
    width / 2,
    (height * REF.timerCenterY) / REF.height,
  );
  ctx.restore();
}
