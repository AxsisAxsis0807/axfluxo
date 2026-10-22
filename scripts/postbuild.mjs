import { readdir, readFile, writeFile } from "node:fs/promises";
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
