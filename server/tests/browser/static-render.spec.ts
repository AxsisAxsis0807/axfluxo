import { test, expect } from "@playwright/test";
import { build } from "esbuild";

test("cached All Versions background and FNF text preserve the legacy composition", async ({ page }) => {
  const result = await build({
    entryPoints: [new URL("static-render-fixture.ts", import.meta.url).pathname],
    bundle: true, write: false, platform: "browser", format: "iife",
    define: { "process.env.NODE_ENV": '"test"' },
  });
  await page.route("https://static-render.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
  );
  await page.goto("https://static-render.test/");
  await page.addScriptTag({ content: result.outputFiles[0].text });
  const report = await page.evaluate(async () =>
    (window as typeof window & {
      compareStaticRendering: () => Promise<{
        all: { mean: number; max: number; major: number };
        fnf: { mean: number; max: number; major: number };
        fnfAudio: { mean: number; max: number; major: number };
        dimensions: number[];
        filenames: string[];
        kinds: string[];
      }>;
    }).compareStaticRendering(),
  );
  expect(report.dimensions).toEqual([1920, 1080, 1080, 1920, 1080, 1920]);
  expect(report.kinds).toEqual(["video", "audio"]);
  expect(report.filenames[0]).toBe("All Versions.mp4");
  expect(report.filenames[1].length).toBeGreaterThan(4);
  // Pixel equality may differ at antialiased edges by a few color levels.
  // Any material change requires reverting the optimization before release.
  expect(report.all.mean).toBeLessThan(0.05);
  expect(report.all.max).toBeLessThanOrEqual(6);
  expect(report.fnf.mean).toBeLessThan(0.05);
  expect(report.fnf.max).toBeLessThanOrEqual(6);
  expect(report.fnfAudio.mean).toBeLessThan(0.05);
  expect(report.fnfAudio.max).toBeLessThanOrEqual(6);
});
