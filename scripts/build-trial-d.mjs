import { execFileSync } from "node:child_process";
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(BLOMP_|NEXT_PUBLIC_|SUPABASE_|DATABASE_URL$)/.test(key),
  ),
);
Object.assign(env, {
  NEXT_PUBLIC_BASE_PATH: "",
  NEXT_PUBLIC_VIDEO_API_ORIGIN: "",
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
});
execFileSync("npm", ["run", "build"], { env, stdio: "inherit" });
await copyFile(
  "tests/fixtures/trial-d/iphone-test-d.zip",
  "out/iphone-test-d.zip",
);
await writeFile(
  "out/index.html",
  `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AxFluxo iPhone試験D</title>
<style>body{margin:2rem auto;padding:0 1rem;max-width:36rem;font:1rem/1.6 system-ui}a{display:inline-flex;align-items:center;min-height:44px}</style>
</head><body>
<h1>AxFluxo iPhone試験D</h1>
<p>端末内で素材を読み込み、動画を書き出す試験版です。</p>
<ul>
<li><a href="./developer/studio/">パスコードを設定して制作を始める</a></li>
<li><a href="./developer/all-versions/">All Versions</a></li>
<li><a href="./developer/fnf-showcase/">FNF Showcase</a></li>
<li><a href="./iphone-test-d.zip" download>試験素材ZIPを取得</a></li>
</ul></body></html>`,
);
// Apply independently of hosting configuration, including deep links.
for (const file of await readdir("out", { recursive: true })) {
  if (!file.endsWith(".html")) continue;
  const path = join("out", file);
  const html = await readFile(path, "utf8");
  const head =
    "<head><meta http-equiv=\"Content-Security-Policy\" content=\"connect-src 'self'; form-action 'self'; object-src 'none'\">";
  if (!html.includes("<head>")) throw Error("Missing static document head");
  await writeFile(path, html.replace("<head>", head));
}
