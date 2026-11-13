import { createCanvas, loadImage } from "@napi-rs/canvas";
import { textImage } from "../../../server/worker/templates/all-versions/graphics";
import { describe, expect, it } from "vitest";
import {
  AV_REFERENCE_LAYOUT,
  AV_RENDERER,
  AV_RENDERER_PREVIOUS,
  allVersionsProjectSchema,
  newProject,
} from "../../../src/domain/video/all-versions";

describe("All Versions reference-frame geometry", () => {
  const height = 864,
    width = (height * 16) / 9,
    layout = AV_REFERENCE_LAYOUT;

  it("1/5: centered square cover uses the full frame height and reference corner radius", () => {
    const side = height * layout.coverSide;
    expect(side).toBe(height);
    expect((width - side) / 2).toBe(336);
    expect(side * layout.coverCornerRadius).toBeCloseTo(36.288, 3);
  });

  it("2/5: text and its tight black band are vertically centered", () => {
    const cy = height * layout.textCenterY,
      bandH = height * layout.textBandHeight;
    expect(cy).toBe(432);
    expect(cy - bandH / 2).toBeCloseTo(402.192, 3);
    expect(cy + bandH / 2).toBeCloseTo(461.808, 3);
  });

  it("3/5: Aleo reference font scales uniformly at both video resolutions", () => {
    expect(height * layout.textSize).toBeCloseTo(47.952, 3);
    expect(1080 * layout.textSize).toBeCloseTo(59.94, 3);
    expect(layout.textScaleX).toBe(1.03);
    // For long version labels, the text shrinks to fit inside the cover.
    expect(layout.textMaxWidth).toBeLessThanOrEqual(layout.coverSide);
  });

  it("4/5: the band uses exactly the measured black opacity", () => {
    expect(layout.textBandOpacity).toBe(0.6);
    expect(layout.textStroke).toBe(0.004);
    expect(layout.textBandHorizontalPadding).toBe(0.0005);
  });

  it("5/5: the blur is full-strength and the old projects remain readable", () => {
    expect(layout.backgroundBlur).toBe(0.095);
    expect(layout.backgroundOverscan).toBe(1.25);
    const p = newProject();
    expect(p.design.rendererVersion).toBe(AV_RENDERER);
    expect(allVersionsProjectSchema.safeParse(p).success).toBe(true);
    const old = {
      ...p,
      design: { ...p.design, rendererVersion: AV_RENDERER_PREVIOUS },
    };
    expect(allVersionsProjectSchema.safeParse(old).success).toBe(true);
  });
});

it("rasterizes white glyph ink at the vertical center of the black label band", async () => {
  const project = newProject();
  project.namesText = "PASA! (NORMAL)";
  const output = await textImage(project, 0);
  const image = await loadImage(output.png);
  const canvas = createCanvas(output.width, output.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, output.width, output.height);
  let minY = output.height, maxY = -1;
  for (let y = 0; y < output.height; y++) {
    for (let x = 0; x < output.width; x++) {
      const i = (y * output.width + x) * 4;
      if (
        pixels.data[i] > 220 &&
        pixels.data[i + 1] > 220 &&
        pixels.data[i + 2] > 220 &&
        pixels.data[i + 3] > 220
      ) {
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  expect(maxY).toBeGreaterThan(minY);
  const inkCenter = (minY + maxY) / 2;
  expect(Math.abs(inkCenter - output.height * AV_REFERENCE_LAYOUT.textCenterY))
    .toBeLessThanOrEqual(2);
});
