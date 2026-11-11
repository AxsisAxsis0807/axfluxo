import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoApi } from "../api/app";
import { ApiError } from "../api/errors";
import type { Database } from "../db/database";
import { cloudExportRouter } from "../cloud-export/api";
import { runExportPass } from "../cloud-export/worker";
import { getJob } from "../cloud-export/queue";
import { testEngine, type TestEngine } from "./engine";
import { exportLimits, EXPORT_PROFILE } from "../../src/domain/cloud-export/schema";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const origin = "https://editor.example";
const owner = randomUUID();
const token = "owner-token";
let pg: TestEngine, directory: string, fixtures: string;
const db: Database = {
  transaction: (work) =>
    pg.transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE axfluxo_export_api");
      return work({ query: (text, values) => tx.query(text, values) });
    }),
};
const workerDb: Database = {
  transaction: (work) =>
    pg.transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE axfluxo_export_worker");
      return work({ query: (text, values) => tx.query(text, values) });
    }),
};
const app = () =>
  createVideoApi({
    db,
    verify: async (authorization) => {
      if (authorization !== `Bearer ${token}`)
        throw new ApiError(401, "AUTH_REQUIRED");
      return { ownerId: owner };
    },
    allowedOrigins: [origin],
    admissionEnabled: () => true,
    response: cloudExportRouter({
      db,
      enabled: () => true,
      maxUploadBytes: exportLimits.maxUploadBytes,
      maxImageBytes: exportLimits.maxImageBytes,
      maxClips: exportLimits.maxClips,
      maxFrames: exportLimits.maxFrames,
    }),
  });
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

async function upload(kind: "video" | "image", bytes: Uint8Array) {
  const response = await app()(
    new Request("https://api.example/v1/cloud-export/blobs", {
      method: "POST",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "x-blob-kind": kind,
        "x-content-sha256": sha(bytes),
        "content-length": String(bytes.byteLength),
      },
      body: bytes as unknown as BodyInit,
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { blob: { id: string } };
}

beforeAll(async () => {
  if (!hasFfmpeg) return;
  directory = await mkdtemp(join(tmpdir(), "axfluxo-export-e2e-db-"));
  fixtures = await mkdtemp(join(tmpdir(), "axfluxo-export-e2e-media-"));
  pg = testEngine(directory);
  for (const name of ["001_video_foundation.sql", "008_cloud_export.sql"])
    await pg.exec(
      await readFile(
        new URL(`../db/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  await pg.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES ($1,true)",
    [owner],
  );
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1920x1080:rate=60:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      "-y",
      join(fixtures, "source.mp4"),
    ],
    { stdio: "ignore", timeout: 120000 },
  );
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x3355aa:s=600x600",
      "-frames:v",
      "1",
      "-y",
      join(fixtures, "cover.png"),
    ],
    { stdio: "ignore", timeout: 60000 },
  );
});
afterAll(async () => {
  if (!hasFfmpeg) return;
  await pg?.close();
});

describe.skipIf(!hasFfmpeg)("cloud export end to end", () => {
  it(
    "uploads real media, renders 1080p60 with FFmpeg and serves ranged MP4",
    async () => {
      const video = new Uint8Array(await readFile(join(fixtures, "source.mp4")));
      const cover = new Uint8Array(await readFile(join(fixtures, "cover.png")));
      expect(video.byteLength).toBeLessThan(exportLimits.maxUploadBytes);
      const videoBlob = await upload("video", video);
      const coverBlob = await upload("image", cover);
      const created = await app()(
        new Request("https://api.example/v1/cloud-export/jobs", {
          method: "POST",
          headers: {
            origin,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify({
            schemaVersion: 1,
            clips: [
              {
                blobId: videoBlob.blob.id,
                startUs: 0,
                endUs: 2_000_000,
                markersUs: [1_000_000],
              },
            ],
            names: ["first chart", "second chart"],
            coverBlobId: coverBlob.blob.id,
            design: {
              height: EXPORT_PROFILE.height,
              fadeInFrames: 9,
              fadeOutFrames: 9,
            },
          }),
        }),
      );
      expect(created.status).toBe(202);
      const job = (await created.json()) as {
        id: string;
        totalFrames: number;
      };
      expect(job.totalFrames).toBe(120);

      const work = await mkdtemp(join(tmpdir(), "axfluxo-export-e2e-work-"));
      const stop = new AbortController();
      const worked = await runExportPass(
        workerDb,
        {
          workDirectory: work,
          maxWorkBytes: 4 * 1024 ** 3,
          minFreeBytes: 256 * 1024 ** 2,
          segmentFrames: 1800,
          sessionTimeoutMs: 240000,
        },
        stop.signal,
      );
      expect(worked).toBe(true);
      const view = await getJob(db, owner, job.id);
      expect(view.errorCode).toBeNull();
      expect(view.state).toBe("succeeded");
      expect(view.output).toMatchObject({
        width: 1920,
        height: 1080,
        fps: 60,
        frames: 120,
      });
      expect(view.output!.size).toBeGreaterThan(1000);

      const output = await app()(
        new Request(
          `https://api.example/v1/cloud-export/jobs/${job.id}/output`,
          { headers: { origin, authorization: `Bearer ${token}` } },
        ),
      );
      expect(output.status).toBe(200);
      expect(output.headers.get("content-type")).toBe("video/mp4");
      const body = new Uint8Array(await output.arrayBuffer());
      expect(body.byteLength).toBe(view.output!.size);
      expect(new TextDecoder().decode(body.subarray(4, 8))).toBe("ftyp");

      const ranged = await app()(
        new Request(
          `https://api.example/v1/cloud-export/jobs/${job.id}/output`,
          {
            headers: {
              origin,
              authorization: `Bearer ${token}`,
              range: "bytes=0-1023",
            },
          },
        ),
      );
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-range")).toBe(
        `bytes 0-1023/${body.byteLength}`,
      );
      const head = new Uint8Array(await ranged.arrayBuffer());
      expect(head.byteLength).toBe(1024);
      expect(head).toEqual(body.subarray(0, 1024));

      const path = join(fixtures, "output.mp4");
      await writeFile(path, body);
      const probe = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            path,
          ],
          { encoding: "utf8", timeout: 60000 },
        ),
      ) as {
        streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
      };
      expect(
        probe.streams.filter((s) => s.codec_type === "video"),
      ).toHaveLength(1);
      expect(
        probe.streams.filter((s) => s.codec_type === "audio"),
      ).toHaveLength(1);
      expect(probe.streams.find((s) => s.codec_type === "video")).toMatchObject({
        codec_name: "h264",
        width: 1920,
        height: 1080,
      });
      expect(
        probe.streams.find((s) => s.codec_type === "audio")?.codec_name,
      ).toBe("aac");
    },
    300000,
  );
});
