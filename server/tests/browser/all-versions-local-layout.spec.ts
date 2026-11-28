import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";
import { REFERENCE_BACKGROUND } from "../../../src/domain/video/all-versions-reference";

test("All Versions local jobs draw the cover, centered title band and version timer", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      resolveDir: resolve("."),
      contents: `
        import { buildLocalJobs } from './src/services/video/local-project';
        window.inspectLayout = async (layout, multiple = false, useCover = true) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 32;
          const cover = canvas.getContext('2d');
          cover.fillStyle = '#40b080';
          cover.fillRect(0, 0, 32, 32);
          const file = new File([], 'sound.wav');
          const [job] = await buildLocalJobs({
            mode: 'all-versions', layout, cover: useCover ? canvas.toDataURL() : '',
            names: 'PASA!(NORMAL)\\n日本語 Café',
            sources: multiple ? [
              { file, url: 'unused', start: 1, end: 3, duration: 6, markers: '' },
              { file, url: 'unused', start: 3, end: 5, duration: 6, markers: '' },
            ] : [{ file, url: 'unused', start: 1, end: 5, duration: 6, markers: '3' }],
            ranges: [],
          });
          canvas.width = job.width;
          canvas.height = job.height;
          const ctx = canvas.getContext('2d');
          const video = document.createElement('video');
          function sample(x, y, w, h) {
            const pixels = ctx.getImageData(x, y, w, h).data;
            let white = 0;
            let dark = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i] > 170 && pixels[i + 1] > 200 && pixels[i + 2] > 170) white++;
              if (pixels[i + 1] < 100) dark++;
            }
            return { white, dark };
          }
          function draw(time) {
            job.draw(ctx, video, time);
            const legacy = layout === 'provisional-v1';
            const side = legacy ? 600 : 1080 * 506 / 512;
            const left = (job.width - side) / 2;
            const top = legacy ? 130 : 1080 * 3 / 512;
            const radius = side * 32 / 722;
            const corners = [false, true].flatMap((right) =>
              [false, true].map((bottom) => [0.24, 0.36].map((fraction) => {
                const inset = radius * fraction;
                const x = left + (right ? side - inset : inset);
                const y = top + (bottom ? side - inset : inset);
                return ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[1];
              })),
            );
            return {
              cover: ctx.getImageData(530, 300, 1, 1).data[1],
              corners,
              title: sample(660, 500, 600, 80),
              clock: sample(905, 925, 110, 40),
              legacyTitle: sample(660, 872, 600, 98).white,
            };
          }
          if (multiple && job.gapBetweenPiecesSeconds !== 0) throw Error('Unexpected production gap');
          return (multiple ? [0, 1, 2, 2, 3, 4] : [0, 1, 2, 3, 4, 1]).map(draw);
        };
      `,
    },
    bundle: true,
    write: false,
    platform: "browser",
    define: { "process.env.NEXT_PUBLIC_BASE_PATH": '""' },
  });
  const url = "https://axfluxo-local-layout.test";
  await page.route(url + "/", (route) =>
    route.fulfill({ body: "<html></html>", contentType: "text/html" }),
  );
  for (const font of ["Aleo.ttf", "ReferenceClock.ttf"]) {
    await page.route(url + "/fonts/" + font, (route) =>
      route.fulfill({ path: "public/fonts/" + font, contentType: "font/ttf" }),
    );
  }
  await page.route(url + "/" + REFERENCE_BACKGROUND, (route) =>
    route.fulfill({ path: "public/" + REFERENCE_BACKGROUND, contentType: "image/webp" }),
  );
  await page.goto(url);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  type Sample = {
    cover: number;
    corners: [number, number][];
    title: { white: number; dark: number };
    clock: { white: number };
    legacyTitle: number;
  };
  const draw = (layout?: string, multiple = false, useCover = true) =>
    page.evaluate(
      ({ layout: value, multiple, useCover }) =>
        (
          window as unknown as {
            inspectLayout: (layout?: string, multiple?: boolean, useCover?: boolean) => Promise<Sample[]>;
          }
        ).inspectLayout(value, multiple, useCover),
      { layout, multiple, useCover },
    );
  const [start, normal, boundary, slowed, end, seek] = await draw();
  expect(normal.cover).toBeGreaterThan(120);
  const [, fallback] = await draw(undefined, false, false);
  expect(fallback.cover).toBeGreaterThan(0);
  expect(fallback.cover).not.toBe(normal.cover);
  expect(normal.title.white).toBeGreaterThan(100);
  expect(normal.title.dark).toBeGreaterThan(100);
  expect(normal.clock.white).toBeGreaterThan(40);
  expect(slowed.title.white).toBeGreaterThan(100);
  expect(slowed.clock).toEqual(normal.clock);
  for (const frame of [start, boundary, end]) {
    expect(frame.cover).toBe(normal.cover);
    expect(frame.title.white).toBe(0);
    expect(frame.clock.white).toBe(0);
  }
  expect(seek).toEqual(normal);
  const [, legacy] = await draw("provisional-v1");
  for (const frame of [legacy]) {
    expect(frame.corners).toHaveLength(4);
    for (const [outside, inside] of frame.corners) {
      expect(outside).toBeLessThan(176);
      expect(inside).toBe(176);
    }
  }
  expect(legacy.cover).toBeLessThan(normal.cover);
  expect(legacy.title.white).toBe(0);
  expect(legacy.legacyTitle).toBeGreaterThan(100);
  const [, before, gapStart, gapMiddle, after, final] = await draw(undefined, true);
  for (const frame of [gapStart, gapMiddle, final]) {
    expect(frame.cover).toBe(before.cover);
    expect(frame.title.white).toBe(0);
    expect(frame.clock.white).toBe(0);
  }
  expect(after.title.white).toBeGreaterThan(100);
  expect(after.clock).toEqual(before.clock);
  const [, legacyBefore, legacyGapStart, legacyGapMiddle, legacyAfter, legacyFinal] = await draw("provisional-v1", true);
  for (const frame of [legacyGapStart, legacyGapMiddle, legacyFinal])
    expect(frame.legacyTitle).toBe(0);
  expect(legacyBefore.legacyTitle).toBeGreaterThan(100);
  expect(legacyAfter.legacyTitle).toBeGreaterThan(100);
});
