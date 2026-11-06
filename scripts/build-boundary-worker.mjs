import { build } from "esbuild";
// Turbopack otherwise copies a new URL(.ts, import.meta.url) as an uncompiled
// static asset. Emit a self-contained same-origin worker for root and Pages paths.
await build({
  entryPoints: ["src/services/video/track-boundary.worker.ts"],
  outfile: "public/workers/track-boundary-v1.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
});
