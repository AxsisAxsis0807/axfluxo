import { mkdir, copyFile } from "node:fs/promises";
const target = "public/local-encoding";
await mkdir(target, { recursive: true });
for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"])
  await copyFile(
    `node_modules/@ffmpeg/core/dist/esm/${name}`,
    `${target}/${name}`,
  );
for (const [source, name] of [
  ["server/worker/templates/all-versions/assets/Aleo.ttf", "Aleo.ttf"],
  [
    "server/worker/templates/fnf-showcase/assets/NotoSansJP.ttf",
    "NotoSansJP.ttf",
  ],
  ["server/worker/templates/all-versions/assets/OFL.txt", "Aleo-OFL.txt"],
  ["server/worker/templates/fnf-showcase/assets/OFL.txt", "NotoSansJP-OFL.txt"],
])
  await copyFile(source, `${target}/${name}`);

for (const name of [
  "worker.js",
  "const.js",
  "errors.js",
  "classes.js",
  "utils.js",
  "types.js",
])
  await copyFile(
    `node_modules/@ffmpeg/ffmpeg/dist/esm/${name}`,
    `${target}/${name}`,
  );

await copyFile(
  "node_modules/@ffmpeg/ffmpeg/dist/esm/index.js",
  `${target}/ffmpeg.js`,
);

await copyFile(
  "public/licenses/ffmpeg-LICENSE.txt",
  `${target}/ffmpeg-LICENSE.txt`,
);
await copyFile(
  "public/licenses/ffmpeg-core-LICENSE.txt",
  `${target}/core-LICENSE.txt`,
);
