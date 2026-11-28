import {
  ALL_VERSIONS_COVER_RADIUS_RATIO,
  ALL_VERSIONS_REFERENCE as REF,
  referenceOpacity,
  referenceTimerText,
  referenceTitleSize,
  type VersionWindow,
} from "../../domain/video/all-versions-reference";

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

export function referenceArtwork(
  cover: HTMLImageElement,
  width: number,
  height: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw Error("Canvasを使用できません。");

  const zoom =
    Math.max(width / cover.width, height / cover.height) * REF.backgroundZoom;
  const w = cover.width * zoom;
  const h = cover.height * zoom;
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, width, height);
  if (typeof ctx.filter === "string") {
    ctx.filter = `blur(${height * REF.backgroundBlurRatio}px)`;
    ctx.drawImage(cover, (width - w) / 2, (height - h) / 2, w, h);
    ctx.filter = "none";
  } else {
    // Older WebKit builds lack Canvas filters. Downsample the backdrop before enlarging it.
    const reduced = document.createElement("canvas");
    reduced.width = 12;
    reduced.height = Math.round((12 * height) / width);
    const small = reduced.getContext("2d");
    if (!small) throw Error("Canvasを使用できません。");
    small.drawImage(
      cover,
      ((width - w) * reduced.width) / width / 2,
      ((height - h) * reduced.height) / height / 2,
      (w * reduced.width) / width,
      (h * reduced.height) / height,
    );
    ctx.drawImage(reduced, 0, 0, width, height);
  }
  ctx.fillStyle = `rgba(0,0,0,${REF.backgroundShade})`;
  ctx.fillRect(0, 0, width, height);
  const side = (height * REF.coverSize) / REF.height;
  drawAllVersionsCover(
    ctx,
    cover,
    (width - side) / 2,
    (height * REF.coverTop) / REF.height,
    side,
  );
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
