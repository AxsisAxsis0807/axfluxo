import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const env = {
  ...process.env,
  NEXT_PUBLIC_IPHONE_PREVIEW: "true",
  NEXT_PUBLIC_BASE_PATH: "",
  NEXT_PUBLIC_VIDEO_API_ORIGIN: "",
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
  GITHUB_SHA: commit,
};
execFileSync("npm", ["run", "build"], { env, stdio: "inherit" });

const target = "work/iphone-preview";
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const path of [
  "_next",
  "fonts",
  "licenses",
  "workers",
  "build-info.json",
  "developer/all-versions",
]) {
  await cp(join("out", path), join(target, path), { recursive: true });
}
await writeFile(
  join(target, "index.html"),
  '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>AxFluxo PR #48</title><h1>AxFluxo PR #48 iPhoneプレビュー</h1><p><a href="/developer/all-versions/">All Versionsを開く</a></p></html>\n',
);
await writeFile(
  join(target, "_headers"),
  `/*
  X-Robots-Tag: noindex, nofollow
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: data:; connect-src 'self' blob: data:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
`,
);
console.log(`PR #48 static preview: ${target} (${commit})`);
