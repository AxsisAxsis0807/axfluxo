import { ALL_VERSIONS_COVER_RADIUS_RATIO } from "../../domain/video/all-versions-reference";
import {
  SHORT_AUDIO_FADE_SECONDS,
  shortReferenceCoverReaction,
  shortReferenceOpacity,
} from "../../domain/video/all-versions-short-reference";
import {
  SHOWCASE_SPECTRUM,
  type ShowcaseFeatures,
} from "../../domain/video/music-showcase-analysis";
import { referenceArtwork } from "./all-versions-canvas";
import type { LocalEncodeJob } from "./local-encode";
import type { Source } from "./local-project";
import { showcaseFeatureProvider } from "./music-showcase-features";

const size = 1080;
const portrait = {
  width: 1080,
  height: 1920,
  x: 0,
  y: 420,
  titleY: 690,
  clockY: 912,
};
const landscape = {
  width: 1920,
  height: 1080,
  x: 420,
  y: 0,
  titleY: 690,
  clockY: 973,
};
const titleFont = '700 56px Arial, "Ax Noto", sans-serif';
const clockFont = "400 30px Arial, sans-serif";

function surface(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("曲紹介の描画領域を確保できません。");
  return { canvas, ctx };
}

function lettering(ctx: CanvasRenderingContext2D, font: string, text: string) {
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "white";
  ctx.shadowColor = "rgba(0,0,0,.72)";
  ctx.shadowBlur = 4;
  ctx.fillText(
    text,
    ctx.canvas.width / 2,
    ctx.canvas.height / 2,
    ctx.canvas.width - 16,
  );
}

// Generate a soft-knee highlight mask and blur it once at reduced size.
// The same 1-4-6-4-1 kernel runs on Safari and Chromium without Canvas filters.
function highlights(artwork: HTMLCanvasElement) {
  const edge = 216;
  const { canvas, ctx } = surface(edge, edge);
  ctx.drawImage(artwork, 0, 0, edge, edge);
  const pixels = ctx.getImageData(0, 0, edge, edge);
  const alpha = new Float32Array(edge * edge);
  const pass = new Float32Array(alpha.length);
  for (let p = 0; p < alpha.length; p++) {
    const i = p * 4;
    const y =
      (pixels.data[i] * 0.2126 +
        pixels.data[i + 1] * 0.7152 +
        pixels.data[i + 2] * 0.0722) /
      255;
    alpha[p] =
      (Math.max(0, (y - 0.55) / 0.45) ** 2 * 255 * pixels.data[i + 3]) / 255;
  }
  const weights = [1, 4, 6, 4, 1];
  const clampEdge = (i: number) => Math.max(0, Math.min(edge - 1, i));
  for (let y = 0; y < edge; y++) {
    for (let x = 0; x < edge; x++) {
      for (let d = -2; d <= 2; d++)
        pass[y * edge + x] +=
          (alpha[y * edge + clampEdge(x + d)] * weights[d + 2]) / 16;
    }
  }
  for (let y = 0; y < edge; y++) {
    for (let x = 0; x < edge; x++) {
      const i = (y * edge + x) * 4;
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
      let value = 0;
      for (let d = -2; d <= 2; d++)
        value += (pass[clampEdge(y + d) * edge + x] * weights[d + 2]) / 16;
      pixels.data[i + 3] = value;
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

export async function musicShowcase(
  cover: HTMLImageElement,
  title: string,
  needsLandscape: boolean,
) {
  await document.fonts.load(titleFont, title);
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title))
    await document.fonts.load('700 56px "Ax Noto"', title);
  await document.fonts.load(clockFont, "00:00");
  const titleLayer = surface(988, 104);
  lettering(titleLayer.ctx, titleFont, title);
  const art = surface(size, size);
  const side = Math.min(cover.naturalWidth, cover.naturalHeight);
  art.ctx.imageSmoothingQuality = "high";
  art.ctx.drawImage(
    cover,
    (cover.naturalWidth - side) / 2,
    (cover.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  const bloom = highlights(art.canvas);
  const background = needsLandscape
    ? await referenceArtwork(cover, landscape.width, landscape.height, false)
    : undefined;
  const getFeatures = showcaseFeatureProvider();

  return function job(
    source: Source,
    start: number,
    end: number,
    layout: "portrait" | "landscape",
    filename: string,
  ): LocalEncodeJob {
    const layoutProfile = layout === "portrait" ? portrait : landscape;
    const { width, height, x, y, titleY, clockY } = layoutProfile;
    const fixed = layout === "landscape" ? background : undefined;
    const duration = end - start;

    function renderer(features?: ShowcaseFeatures): LocalEncodeJob["draw"] {
      const clock = surface(256, 64);
      let lastSecond = -1;
      return (ctx, _media, seconds) => {
        const elapsed = Math.max(0, Math.min(seconds, duration));
        const opacity = shortReferenceOpacity(elapsed, duration, true);
        const response = features?.sample(elapsed);
        const reaction = shortReferenceCoverReaction(elapsed, duration);
        const exposure = 1 + ((response?.exposure ?? 1) - 1) * reaction;
        ctx.save();
        ctx.fillStyle = "#000";
        if (fixed) ctx.drawImage(fixed, 0, 0);
        else ctx.fillRect(0, 0, width, height);
        ctx.translate(x, y);
        ctx.save();
        if (fixed) {
          ctx.beginPath();
          ctx.roundRect(
            0,
            0,
            size,
            size,
            size * ALL_VERSIONS_COVER_RADIUS_RATIO,
          );
          ctx.clip();
        }
        ctx.fillRect(0, 0, size, size);
        ctx.globalAlpha = opacity.cover;
        ctx.drawImage(art.canvas, 0, 0);
        if (exposure < 1) {
          ctx.globalAlpha = 1 - exposure;
          ctx.fillRect(0, 0, size, size);
        }
        if (exposure > 1) {
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = opacity.cover * (exposure - 1);
          ctx.drawImage(art.canvas, 0, 0);
        }
        ctx.globalCompositeOperation = "screen";
        const intensity = opacity.cover * reaction * (response?.glow ?? 0) * 0.22;
        if (intensity > 0) {
          ctx.globalAlpha = intensity;
          ctx.drawImage(bloom, 0, 0, size, size);
        }
        ctx.restore();

        const { count, pitch, stroke, baseline, minHeight, maxHeight } =
          SHOWCASE_SPECTRUM;
        const left = (size - ((count - 1) * pitch + stroke)) / 2;
        ctx.fillStyle = "#fff";
        ctx.globalAlpha = opacity.clock * 0.36;
        ctx.fillRect(left, baseline - 0.4, (count - 1) * pitch + stroke, 0.8);
        ctx.globalAlpha = opacity.clock * SHOWCASE_SPECTRUM.opacity;
        for (let i = 0; i < count; i++) {
          const h =
            minHeight +
            (maxHeight - minHeight) * ((response?.bars[i] ?? 0) / 255);
          ctx.fillRect(left + i * pitch, baseline - h / 2, stroke, h);
        }
        ctx.globalAlpha = opacity.title;
        ctx.drawImage(
          titleLayer.canvas,
          (size - titleLayer.canvas.width) / 2,
          titleY - titleLayer.canvas.height / 2,
        );
        const whole = Math.floor(elapsed + 1e-6);
        if (whole !== lastSecond) {
          clock.ctx.clearRect(0, 0, clock.canvas.width, clock.canvas.height);
          lettering(
            clock.ctx,
            clockFont,
            `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`,
          );
          lastSecond = whole;
        }
        ctx.globalAlpha = opacity.clock;
        ctx.drawImage(
          clock.canvas,
          (size - clock.canvas.width) / 2,
          clockY - clock.canvas.height / 2,
        );
        ctx.restore();
      };
    }

    return {
      filename,
      width,
      height,
      timestamped: true,
      requireTimedMp4: true,
      audioFadeOutSeconds: Math.min(duration, SHORT_AUDIO_FADE_SECONDS),
      pieces: [
        {
          file: source.file,
          url: async () => source.url,
          start,
          end,
          sourceDuration: source.duration,
        },
      ],
      draw: renderer(),
      prepareVideo: async (signal) =>
        renderer(await getFeatures(source, start, end, signal)),
    };
  };
}
