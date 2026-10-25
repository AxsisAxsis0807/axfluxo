import { expect, it } from "vitest";
import { imageHeaderDimensions } from "../src/services/image-header";
it("reads bounded PNG/JPEG/WebP dimensions without decoding", () => {
  const png = new Uint8Array(24),
    view = new DataView(png.buffer);
  view.setUint32(16, 8193);
  view.setUint32(20, 2);
  expect(imageHeaderDimensions(png, "image/png")).toEqual({
    width: 8193,
    height: 2,
  });
  const jpeg = new Uint8Array([255, 216, 255, 192, 0, 7, 8, 0, 40, 0, 80]);
  expect(imageHeaderDimensions(jpeg, "image/jpeg")).toEqual({
    width: 80,
    height: 40,
  });
  const webp = new Uint8Array(30);
  webp.set([86, 80, 56, 88], 12);
  webp[24] = 99;
  webp[27] = 49;
  expect(imageHeaderDimensions(webp, "image/webp")).toEqual({
    width: 100,
    height: 50,
  });
  expect(
    imageHeaderDimensions(
      new Uint8Array([255, 216, 255, 192, 255, 255]),
      "image/jpeg",
    ),
  ).toBeUndefined();
});
