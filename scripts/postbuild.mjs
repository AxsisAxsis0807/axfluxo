import { execFileSync } from "node:child_process";
import {
  readdir,
  readFile,
  writeFile,
  copyFile,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
if (base && !/^\/[A-Za-z0-9_-]+$/.test(base))
  throw Error("Invalid static base path");
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (base && entry.name.endsWith(".css")) {
      const css = await readFile(path, "utf8");
      await writeFile(
        path,
        css
          .replaceAll("url(/fonts/", `url(${base}/fonts/`)
          .replaceAll('url("/fonts/', `url("${base}/fonts/`)
          .replaceAll("url('/fonts/", `url('${base}/fonts/`),
      );
    }
  }
}
await walk("out");
await writeFile("out/.nojekyll", "");

// The new diagnostic route also has RSC files in this directory. Give static
// hosts an index without changing the existing root/export URL conventions.
for (const route of [
  "studio",
  "video",
  "library",
  "preview",
  "all-versions",
  "fnf-showcase",
]) {
  await mkdir(`out/developer/${route}`, { recursive: true });
  await copyFile(
    `out/developer/${route}.html`,
    `out/developer/${route}/index.html`,
  );
}

const manifest = JSON.parse(
  await readFile("public/developer.webmanifest", "utf8"),
);
manifest.id = `${base}/developer/studio/`;
manifest.start_url = manifest.id;
manifest.scope = `${base}/developer/`;
manifest.icons[0].src = `${base}/developer-icon.svg`;
await writeFile("out/developer.webmanifest", JSON.stringify(manifest));

// Public provenance, with no runtime credentials or environment dump.
const sourceCommit =
  process.env.GITHUB_SHA ||
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
await writeFile(
  "out/build-info.json",
  JSON.stringify({ commit: sourceCommit, builtAt: new Date().toISOString() }),
);
