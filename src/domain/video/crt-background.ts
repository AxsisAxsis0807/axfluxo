// Version the composition so a resumed render cannot mix frames from different backgrounds.
export const CRT_BACKGROUND_VERSION = "crt-cover-v1";

type CrtCanvas<Image> = {
  fillStyle: unknown;
  imageSmoothingQuality: string;
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
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
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { data: Uint8ClampedArray };
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): Gradient;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  bezierCurveTo(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x: number,
    y: number,
  ): void;
  roundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void;
  closePath(): void;
  fill(): void;
  clip(): void;
};

type Gradient = { addColorStop(offset: number, color: string): void };

export function drawCrtBackground<Image>(
  ctx: CrtCanvas<Image>,
  width: number,
  height: number,
  image: Image,
  imageWidth: number,
  imageHeight: number,
) {
  const side = Math.min(imageWidth, imageHeight);
  const sx = (imageWidth - side) / 2;
  const sy = (imageHeight - side) / 2;
  const sample = 16;

  ctx.save();
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, sample, sample);
  ctx.drawImage(image, sx, sy, side, side, 0, 0, sample, sample);
  const pixels = ctx.getImageData(0, 0, sample, sample).data;
  const colors = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let y = 0; y < sample; y++) {
    for (let x = 0; x < sample; x++) {
      const color = colors[Math.floor(x / (sample / 2))];
      const offset = (y * sample + x) * 4;
      for (let c = 0; c < 3; c++) color[c] += pixels[offset + c];
    }
  }
  const light = colors.map((color) =>
    color
      .map((value, channel) =>
        Math.round(
          (value / ((sample * sample) / 2)) * 0.76 + [15, 20, 29][channel],
        ),
      )
      .join(","),
  );

  ctx.scale(width / 1280, height / 720);
  ctx.fillStyle = "#060c16";
  ctx.fillRect(0, 0, 1280, 720);
  for (const [index, x] of [295, 1055].entries()) {
    const glow = ctx.createRadialGradient(x, 295, 0, x, 295, 555);
    glow.addColorStop(0, `rgba(${light[index]},${index === 0 ? 0.8 : 1})`);
    glow.addColorStop(1, `rgba(${light[index]},0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 1280, 720);
  }

  ctx.fillStyle = "#020305";
  ctx.beginPath();
  ctx.roundRect(284, 0, 712, 720, 33);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(345, 60);
  ctx.bezierCurveTo(470, 23, 810, 23, 935, 60);
  ctx.bezierCurveTo(974, 184, 974, 536, 935, 660);
  ctx.bezierCurveTo(810, 697, 470, 697, 345, 660);
  ctx.bezierCurveTo(306, 536, 306, 184, 345, 60);
  ctx.closePath();
  ctx.clip();

  ctx.drawImage(image, sx, sy, side, side, 313, 33, 654, 654);
  const vignette = ctx.createRadialGradient(646, 328, 85, 646, 352, 450);
  vignette.addColorStop(0, "rgba(3,8,16,0.07)");
  vignette.addColorStop(0.64, "rgba(3,8,16,0.16)");
  vignette.addColorStop(1, "rgba(3,8,16,0.81)");
  ctx.fillStyle = vignette;
  ctx.fillRect(313, 33, 654, 654);

  const reflection = ctx.createRadialGradient(927, 272, 0, 912, 253, 280);
  reflection.addColorStop(0, "rgba(216,236,255,0.38)");
  reflection.addColorStop(0.32, "rgba(216,236,255,0.17)");
  reflection.addColorStop(1, "rgba(216,236,255,0)");
  ctx.fillStyle = reflection;
  ctx.fillRect(313, 33, 654, 654);

  ctx.fillStyle = "rgba(2,5,10,0.13)";
  for (let y = 34; y < 688; y += 3) ctx.fillRect(313, y, 654, 1);
  ctx.fillStyle = "rgba(216,236,255,0.045)";
  for (let x = 314; x < 966; x += 5) ctx.fillRect(x, 33, 1, 654);
  ctx.restore();
}
