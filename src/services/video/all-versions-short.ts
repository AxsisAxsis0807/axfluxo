import type { LocalEncodeJob } from "./local-encode";
import type { Source } from "./local-project";

export type ShortRange = { start: number; end: number };
export type AllVersionsShort = ShortRange & { sourceId: string; title: string };

export function initialShortRange(duration: number): ShortRange {
  return { start: 0, end: Math.min(48, duration) };
}

export function validShortRange(range: ShortRange, duration: number) {
  return (
    Number.isFinite(range.start) &&
    Number.isFinite(range.end) &&
    range.start >= 0 &&
    range.end <= duration &&
    range.end - range.start >= Math.min(1 / 60, duration)
  );
}

const width = 1080;
const height = 1920;
const squareTop = 420;

export function allVersionsShortJob(
  short: AllVersionsShort,
  source: Source,
  cover: HTMLImageElement,
): LocalEncodeJob {
  const artwork = document.createElement("canvas");
  artwork.width = artwork.height = width;
  const image = artwork.getContext("2d", { alpha: false });
  if (!image) throw Error("カバー画像を描画できません。");
  const side = Math.min(cover.naturalWidth, cover.naturalHeight);
  image.imageSmoothingQuality = "high";
  image.drawImage(
    cover,
    (cover.naturalWidth - side) / 2,
    (cover.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    width,
    width,
  );
  image.fillStyle = "rgba(0,0,0,0.15)";
  image.fillRect(0, 0, width, width);

  const title = short.title.trim().toUpperCase();
  const duration = short.end - short.start;
  return {
    filename: "All Versions Short.mp4",
    width,
    height,
    timestamped: true,
    pieces: [
      {
        file: source.file,
        url: async () => source.url,
        start: short.start,
        end: short.end,
        sourceDuration: source.duration,
      },
    ],
    draw(ctx, _media, seconds) {
      const time = Math.min(duration, Math.max(0, seconds));
      const fade = Math.min(duration / 3, 0.7);
      const opacity = Math.min(1, time / fade, (duration - time) / fade);
      ctx.save();
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 0.24 + 0.76 * opacity;
      ctx.drawImage(artwork, 0, squareTop);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "white";
      ctx.globalAlpha = opacity;
      ctx.font = "700 56px Arial, sans-serif";
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur = 6;
      ctx.fillText(title, width / 2, 1110, width * 0.9);
      ctx.shadowBlur = 0;
      const whole = Math.floor(time + 1e-6);
      const minutes = String(Math.floor(whole / 60)).padStart(2, "0");
      const remainder = String(whole % 60).padStart(2, "0");
      ctx.font = "400 30px Arial, sans-serif";
      ctx.fillText(`${minutes}:${remainder}`, width / 2, 1332);
      ctx.restore();
    },
  };
}
