// Offline diagnostic only: synthetic files, real FFmpeg, no DB/provider connections.
// NODE_OPTIONS=--max-old-space-size=128 VIDEO_RENDER_DISK=<isolated directory>
// npx tsx server/tests/unified-resource-smoke.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mediaProcess } from "../worker/render/process";
import { renderExport, exportFileHash } from "../cloud-export/render";
import { runWorker } from "../worker/runtime/service";
import {
  EXPORT_PROFILE,
  EXPORT_RENDERER,
  EXPORT_FONT_HASH,
} from "../../src/domain/cloud-export/schema";
const root = process.env.VIDEO_RENDER_DISK;
if (!root) throw Error("An isolated VIDEO_RENDER_DISK is required");
const stop = new AbortController();
await runWorker(
  [
    {
      name: "legacy-synthetic",
      enabled: () => true,
      async run(signal) {
        const dir = join(root, "export");
        await mkdir(dir, { recursive: true });
        const source = join(dir, "source.mp4"),
          cover = join(dir, "cover.png");
        await mediaProcess(
          "ffmpeg",
          [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=60:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=sample_rate=48000:duration=1",
            "-c:v",
            "libx264",
            "-threads",
            "1",
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-y",
            source,
          ],
          { signal },
        );
        await mediaProcess(
          "ffmpeg",
          [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=160x90",
            "-frames:v",
            "1",
            "-threads",
            "1",
            "-y",
            cover,
          ],
          { signal },
        );
        const output = await renderExport({
          jobId: randomUUID(),
          directory: dir,
          sources: [
            {
              blobId: "clip",
              path: source,
              hash: await exportFileHash(source),
            },
          ],
          cover: {
            blobId: "cover",
            path: cover,
            hash: await exportFileHash(cover),
          },
          segmentFrames: 60,
          signal,
          onProgress: async () => {},
          spec: {
            schemaVersion: 1,
            clips: [
              { blobId: "clip", startUs: 0, endUs: 1000000, markersUs: [] },
            ],
            coverBlobId: "cover",
            names: ["synthetic"],
            design: {
              height: EXPORT_PROFILE.height,
              fadeInFrames: 9,
              fadeOutFrames: 9,
              fontHash: EXPORT_FONT_HASH,
              rendererVersion: EXPORT_RENDERER,
              layout: "provisional-v1",
            },
          },
        });
        console.log(JSON.stringify({ stage: "legacy", ...output }));
      },
    },
    {
      name: "render-synthetic",
      enabled: () => true,
      async run() {
        // Existing generic 160x90 AV/FNF fixture, not production 1080p template coverage.
        process.env.VIDEO_RENDER_DISK = join(root, "render");
        await import("./render/container-smoke");
      },
    },
  ],
  stop.signal,
  {
    pause: async () => {
      stop.abort();
    },
    onError: () => {
      process.exitCode = 1;
      stop.abort();
    },
  },
);
