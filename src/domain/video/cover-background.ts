import { ALL_VERSIONS_COVER_RADIUS_RATIO } from "./all-versions-reference";

// Part of the checkpoint hash so resumed jobs cannot mix background styles.
export const COVER_BACKGROUND_VERSION = "blurred-cover-v1";

export const COVER_BLUR_WIDTH = 128;
export const COVER_BLUR_HEIGHT = 72;

type DrawContext<Image> = {
  fillStyle: unknown;
  imageSmoothingQuality: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(
    image: Image,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void;
};

type OutputContext<Image> = DrawContext<Image> & {
  save(): void;
  restore(): void;
  beginPath(): void;
  roundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void;
  clip(): void;
};

type Pixels = { data: Uint8ClampedArray };
type BlurContext<Image, Data extends Pixels> = DrawContext<Image> & {
  getImageData(x: number, y: number, width: number, height: number): Data;
  putImageData(data: Data, x: number, y: number): void;
};

const radius = 12;
const sigma = 4.3;
const weights = Array.from({ length: 2 * radius + 1 }, (_, index) => {
  const distance = index - radius;
  return Math.exp(-(distance ** 2) / (2 * sigma ** 2));
});
const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

function blur(pixels: Uint8ClampedArray, width: number, height: number) {
  const horizontal = new Float32Array(pixels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4;
      for (let k = -radius; k <= radius; k++) {
        const source =
          (y * width + Math.min(width - 1, Math.max(0, x + k))) * 4;
        const weight = weights[k + radius] / weightSum;
        for (let c = 0; c < 3; c++)
          horizontal[target + c] += pixels[source + c] * weight;
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        let color = 0;
        for (let k = -radius; k <= radius; k++) {
          const source =
            (Math.min(height - 1, Math.max(0, y + k)) * width + x) * 4;
          color += (horizontal[source + c] * weights[k + radius]) / weightSum;
        }
        pixels[target + c] = color * 0.92;
      }
    }
  }
}

export function drawCoverBackground<Image, Data extends Pixels>(
  output: OutputContext<Image>,
  background: BlurContext<Image, Data>,
  backgroundCanvas: Image,
  width: number,
  height: number,
  cover: Image,
  coverWidth: number,
  coverHeight: number,
) {
  const bw = COVER_BLUR_WIDTH;
  const bh = COVER_BLUR_HEIGHT;
  const zoom = Math.max(bw / coverWidth, bh / coverHeight);
  const sourceWidth = bw / zoom;
  const sourceHeight = bh / zoom;
  background.fillStyle = "#000";
  background.fillRect(0, 0, bw, bh);
  background.imageSmoothingQuality = "high";
  background.drawImage(
    cover,
    (coverWidth - sourceWidth) / 2,
    (coverHeight - sourceHeight) / 2,
    sourceWidth,
    sourceHeight,
    0,
    0,
    bw,
    bh,
  );
  const pixels = background.getImageData(0, 0, bw, bh);
  blur(pixels.data, bw, bh);
  background.putImageData(pixels, 0, 0);

  output.save();
  output.imageSmoothingQuality = "high";
  output.drawImage(backgroundCanvas, 0, 0, bw, bh, 0, 0, width, height);
  const crop = Math.min(coverWidth, coverHeight);
  const side = height;
  const left = (width - side) / 2;
  output.beginPath();
  output.roundRect(left, 0, side, side, side * ALL_VERSIONS_COVER_RADIUS_RATIO);
  output.clip();
  output.drawImage(
    cover,
    (coverWidth - crop) / 2,
    (coverHeight - crop) / 2,
    crop,
    crop,
    left,
    0,
    side,
    side,
  );
  output.restore();
}
