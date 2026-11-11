import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoApi } from "../api/app";
import { ApiError } from "../api/errors";
import type { Database, Sql } from "../db/database";
import { cloudExportRouter, ticketDownload } from "../cloud-export/api";
import {
  claim,
  cancelJob,
  finishFailure,
  getJob,
  heartbeat,
  progress,
  publish,
  purgeExpired,
} from "../cloud-export/queue";
import { beginBlob, storeBlob, discardBlob } from "../cloud-export/storage";
import { testEngine, type TestEngine } from "./engine";
import { exportLimits, EXPORT_PROFILE } from "../../src/domain/cloud-export/schema";

const origin = "https://editor.example";
let pg: TestEngine, directory: string;
const owner = randomUUID(),
  other = randomUUID();
const ownerToken = "owner-token";

function apiDb(role: string): Database {
  return {
    transaction: (work) =>
      pg.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        return work({ query: (text, values) => tx.query(text, values) });
      }),
  };
}
const db = apiDb("axfluxo_export_api");
const workerDb = apiDb("axfluxo_export_worker");

let enabled = true;
const app = () =>
  createVideoApi({
    db,
    verify: async (authorization) => {
      if (authorization !== `Bearer ${ownerToken}`)
        throw new ApiError(401, "AUTH_REQUIRED");
      return { ownerId: owner };
    },
    allowedOrigins: [origin],
    admissionEnabled: () => true,
    response: cloudExportRouter({
      db,
      enabled: () => enabled,
      maxUploadBytes: exportLimits.maxUploadBytes,
      maxImageBytes: exportLimits.maxImageBytes,
      maxClips: exportLimits.maxClips,
      maxFrames: exportLimits.maxFrames,
      maxOwnerBytes: 256 * 1024 ** 2,
      retentionHours: 24,
      ticketSeconds: 120,
    }),
    public: ticketDownload({ db }),
  });

function sha(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}
function bytes(size: number, seed = 7) {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * seed) % 251;
  return data;
}
function uploadRequest(
  kind: "video" | "image",
  data: Uint8Array,
  override: { sha?: string; length?: number } = {},
) {
  return new Request("https://api.example/v1/cloud-export/blobs", {
    method: "POST",
    headers: {
      origin,
      authorization: `Bearer ${ownerToken}`,
      "x-blob-kind": kind,
      "x-content-sha256": override.sha ?? sha(data),
      "content-length": String(override.length ?? data.byteLength),
    },
    body: data as unknown as BodyInit,
  });
}
async function upload(kind: "video" | "image", data: Uint8Array) {
  const response = await app()(uploadRequest(kind, data));
  return {
    status: response.status,
    body: (await response.json()) as {
      blob: { id: string; kind: string; size: number; sha256: string };
      error?: { code: string };
    },
  };
}
function jobBody(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    clips: [
      {
        blobId: randomUUID(),
        startUs: 0,
        endUs: 2_000_000,
        markersUs: [],
      },
    ],
    names: ["version one"],
    coverBlobId: randomUUID(),
    design: { height: EXPORT_PROFILE.height, fadeInFrames: 9, fadeOutFrames: 9 },
    ...overrides,
  };
}
function post(path: string, body: unknown, key = randomUUID()) {
  return new Request(`https://api.example${path}`, {
    method: "POST",
    headers: {
      origin,
      authorization: `Bearer ${ownerToken}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "axfluxo-export-"));
  pg = testEngine(directory);
  for (const name of [
    "001_video_foundation.sql",
    "008_cloud_export.sql",
    "009_cloud_export_retention.sql",
  ])
    await pg.exec(
      await readFile(
        new URL(`../db/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  await pg.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES ($1,true),($2,true)",
    [owner, other],
  );
});
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  enabled = true;
});

describe("cloud export blobs", () => {
  it("streams a declared-size body into verified bytes and dedupes by hash", async () => {
    const data = bytes(3 * 1024 * 1024 + 17);
    const first = await upload("video", data);
    expect(first.status).toBe(201);
    expect(first.body.blob.size).toBe(data.byteLength);
    expect(first.body.blob.sha256).toBe(sha(data));
    const stored = await pg.query<{ total: string; chunks: string }>(
      "SELECT coalesce(sum(byte_length),0) AS total,count(*) AS chunks FROM axfluxo_export.blob_chunks WHERE blob_id=$1",
      [first.body.blob.id],
    );
    expect(Number(stored.rows[0].total)).toBe(data.byteLength);
    expect(Number(stored.rows[0].chunks)).toBe(4);
    const second = await upload("video", data);
    expect(second.status).toBe(200);
    expect(second.body.blob.id).toBe(first.body.blob.id);
    const count = await pg.query<{ n: string }>(
      "SELECT count(*) AS n FROM axfluxo_export.blobs",
      [],
    );
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it("rejects a hash mismatch and removes the incomplete upload", async () => {
    const data = bytes(1024 * 1024);
    const response = await app()(
      uploadRequest("video", data, { sha: "0".repeat(64) }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: { code: "EXPORT_HASH_MISMATCH" },
    });
    const found = await pg.query<{ n: string }>(
      "SELECT count(*) AS n FROM axfluxo_export.blobs WHERE owner_id=$1 AND sha256=$2",
      [owner, "0".repeat(64)],
    );
    expect(Number(found.rows[0].n)).toBe(0);
  });

  it("rejects an overstated declaration and an unsupported kind", async () => {
    const data = bytes(4096);
    const response = await app()(
      uploadRequest("video", data, { length: data.byteLength + 1 }),
    );
    expect(response.status).toBe(400);
    const kind = await app()(
      new Request("https://api.example/v1/cloud-export/blobs", {
        method: "POST",
        headers: {
          origin,
          authorization: `Bearer ${ownerToken}`,
          "x-blob-kind": "application/pdf",
          "x-content-sha256": sha(data),
          "content-length": String(data.byteLength),
        },
        body: data,
      }),
    );
    expect(kind.status).toBe(400);
  });

  it("refuses uploads when admission is closed", async () => {
    enabled = false;
    const response = await app()(uploadRequest("video", bytes(1024)));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "EXPORT_DISABLED" },
    });
  });

  it("does not expose raw errors to the caller", async () => {
    const response = await app()(
      new Request("https://api.example/v1/cloud-export/blobs", {
        method: "POST",
        headers: {
          origin,
          authorization: `Bearer ${ownerToken}`,
          "x-blob-kind": "video",
          "x-content-sha256": "not-a-hash",
          "content-length": "10",
        },
        body: bytes(10),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "EXPORT_HASH_MISMATCH" },
    });
  });
});

describe("cloud export admission without a database", () => {
  it("reports disabled and refuses work without opening a connection", async () => {
    const disabled = createVideoApi({
      db,
      verify: async () => ({ ownerId: owner }),
      allowedOrigins: [origin],
      admissionEnabled: () => true,
      response: cloudExportRouter({
        db: null,
        enabled: () => false,
        maxUploadBytes: exportLimits.maxUploadBytes,
        maxImageBytes: exportLimits.maxImageBytes,
        maxClips: exportLimits.maxClips,
        maxFrames: exportLimits.maxFrames,
        maxOwnerBytes: 256 * 1024 ** 2,
        retentionHours: 24,
        ticketSeconds: 120,
      }),
    });
    const session = await disabled(
      new Request("https://api.example/v1/cloud-export/session", {
        headers: { origin, authorization: "Bearer x" },
      }),
    );
    expect(session.status).toBe(200);
    expect((await session.json()).enabled).toBe(false);
    const uploadResponse = await disabled(uploadRequest("video", bytes(10)));
    expect(uploadResponse.status).toBe(503);
    expect(await uploadResponse.json()).toEqual({
      error: { code: "EXPORT_DISABLED" },
    });
  });
});

describe("cloud export jobs", () => {
  it("validates names, ownership and limits before queueing", async () => {
    const video = await upload("video", bytes(2048));
    const cover = await upload("image", bytes(1024, 3));
    const valid = jobBody({
      clips: [
        { blobId: video.body.blob.id, startUs: 0, endUs: 2_000_000, markersUs: [] },
      ],
      coverBlobId: cover.body.blob.id,
    });
    expect((await app()(post("/v1/cloud-export/jobs", valid))).status).toBe(202);
    const nameMismatch = jobBody({
      clips: [
        {
          blobId: video.body.blob.id,
          startUs: 0,
          endUs: 2_000_000,
          markersUs: [1_000_000],
        },
      ],
      coverBlobId: cover.body.blob.id,
    });
    expect(
      (await app()(post("/v1/cloud-export/jobs", nameMismatch))).status,
    ).toBe(400);
    const missing = jobBody({ coverBlobId: cover.body.blob.id });
    expect((await app()(post("/v1/cloud-export/jobs", missing))).status).toBe(
      404,
    );
    const tooLong = jobBody({
      clips: [
        {
          blobId: video.body.blob.id,
          startUs: 0,
          endUs: 3_600_000_000,
          markersUs: [],
        },
      ],
      coverBlobId: cover.body.blob.id,
    });
    expect((await app()(post("/v1/cloud-export/jobs", tooLong))).status).toBe(
      400,
    );
  });

  it("is idempotent per key and conflicts on a different body", async () => {
    const video = await upload("video", bytes(2048));
    const cover = await upload("image", bytes(1024, 3));
    const body = jobBody({
      clips: [
        { blobId: video.body.blob.id, startUs: 0, endUs: 1_000_000, markersUs: [] },
      ],
      coverBlobId: cover.body.blob.id,
    });
    const key = randomUUID();
    const first = await app()(post("/v1/cloud-export/jobs", body, key));
    const second = await app()(post("/v1/cloud-export/jobs", body, key));
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const a = (await first.json()) as { id: string; totalFrames: number };
    const b = (await second.json()) as { id: string };
    expect(a.id).toBe(b.id);
    expect(a.totalFrames).toBe(60);
    const changed = await app()(
      post(
        "/v1/cloud-export/jobs",
        { ...body, names: ["version two"] },
        key,
      ),
    );
    expect(changed.status).toBe(409);
  });

  it("keeps jobs and bytes private to their owner", async () => {
    const video = await upload("video", bytes(2048));
    const cover = await upload("image", bytes(1024, 3));
    const created = await app()(
      post(
        "/v1/cloud-export/jobs",
        jobBody({
          clips: [
            {
              blobId: video.body.blob.id,
              startUs: 0,
              endUs: 1_000_000,
              markersUs: [],
            },
          ],
          coverBlobId: cover.body.blob.id,
        }),
      ),
    );
    const job = (await created.json()) as { id: string };
    const otherView = await getJob(db, other, job.id).catch(
      (error: { status?: number }) => error,
    );
    expect((otherView as { status: number }).status).toBe(404);
    await expect(
      db.transaction((sql: Sql) =>
        sql.query("SELECT * FROM axfluxo_export.jobs WHERE owner_id=$1", [
          other,
        ]),
      ),
    ).resolves.toBeDefined();
    const leaked = await db.transaction((sql: Sql) =>
      sql.query("SELECT id FROM axfluxo_export.jobs WHERE owner_id=$1", [
        other,
      ]),
    );
    expect(leaked.rows).toHaveLength(0);
  });

  it("cancels a queued job and refuses a second cancellation", async () => {
    const video = await upload("video", bytes(2048));
    const cover = await upload("image", bytes(1024, 3));
    const created = await app()(
      post(
        "/v1/cloud-export/jobs",
        jobBody({
          clips: [
            {
              blobId: video.body.blob.id,
              startUs: 0,
              endUs: 1_000_000,
              markersUs: [],
            },
          ],
          coverBlobId: cover.body.blob.id,
        }),
      ),
    );
    const job = (await created.json()) as { id: string };
    const cancelled = await cancelJob(db, owner, job.id);
    expect(cancelled.state).toBe("cancelled");
    await expect(cancelJob(db, owner, job.id)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("cloud export worker queue", () => {
  /** Keeps each worker test independent of jobs left queued by earlier API tests. */
  async function drain() {
    await pg.query(
      "UPDATE axfluxo_export.jobs SET state='failed',error_code='EXPORT_WORKER_LOST',finished_at=now() WHERE state IN ('queued','running','cancel_requested')",
      [],
    );
    await pg.query(
      "UPDATE axfluxo_export.slot SET owner_id=NULL,job_id=NULL,lease_until=NULL WHERE id=1",
      [],
    );
  }
  async function queuedJob(durationUs = 1_000_000) {
    await drain();
    const video = await upload("video", bytes(4096));
    const cover = await upload("image", bytes(1024, 3));
    const created = await app()(
      post(
        "/v1/cloud-export/jobs",
        jobBody({
          clips: [
            {
              blobId: video.body.blob.id,
              startUs: 0,
              endUs: durationUs,
              markersUs: [],
            },
          ],
          coverBlobId: cover.body.blob.id,
        }),
      ),
    );
    const job = (await created.json()) as { id: string };
    return { job, video: video.body.blob, cover: cover.body.blob };
  }

  it("leases one job at a time and fences a stale worker", async () => {
    const { job } = await queuedJob();
    const first = await claim(workerDb);
    expect(first?.job).toBe(job.id);
    expect(await claim(workerDb)).toBeNull();
    await heartbeat(workerDb, first!);
    await progress(workerDb, first!, 12);
    const view = await getJob(db, owner, job.id);
    expect(view.state).toBe("running");
    expect(view.completedFrames).toBe(12);
    // A lost worker's lease is recovered, not duplicated.
    await pg.query(
      "UPDATE axfluxo_export.slot SET lease_until=clock_timestamp()-interval '1 second'",
      [],
    );
    const second = await claim(workerDb);
    expect(second?.job).toBe(job.id);
    expect(second?.token).not.toBe(first?.token);
    await expect(heartbeat(workerDb, first!)).rejects.toMatchObject({
      code: "EXPORT_LEASE_LOST",
    });
    await finishFailure(workerDb, second!, new Error("boom"));
    const failed = await getJob(db, owner, job.id);
    expect(failed.state).toBe("failed");
    expect(failed.errorCode).toBe("EXPORT_OUTPUT_INVALID");
  });

  it("honours a cancellation requested during execution", async () => {
    const { job } = await queuedJob();
    const claimed = await claim(workerDb);
    await cancelJob(db, owner, job.id);
    await expect(heartbeat(workerDb, claimed!)).rejects.toMatchObject({
      code: "EXPORT_CANCELLED",
    });
    await finishFailure(workerDb, claimed!, new Error("cancelled"));
    expect((await getJob(db, owner, job.id)).state).toBe("cancelled");
  });

  it("serves stored output with byte ranges and refuses foreign ranges", async () => {
    const { job } = await queuedJob();
    const claimed = await claim(workerDb);
    const output = bytes(1024 * 1024 + 5, 11);
    const blobId = randomUUID();
    await storeBlob(db, owner, {
      id: blobId,
      kind: "output",
      sha256: sha(output),
      size: output.byteLength,
      chunks: (async function* () {
        yield output.subarray(0, exportLimits.chunkBytes);
        yield output.subarray(exportLimits.chunkBytes);
      })(),
    });
    await publish(workerDb, claimed!, {
      blobId,
      size: output.byteLength,
      sha256: sha(output),
      validation: {
        width: 1920,
        height: 1080,
        frames: 60,
        durationUs: 1_000_000,
      },
    });
    const view = await getJob(db, owner, job.id);
    expect(view.state).toBe("succeeded");
    expect(view.output?.size).toBe(output.byteLength);
    const send = (headers: Record<string, string> = {}) =>
      app()(
        new Request(
          `https://api.example/v1/cloud-export/jobs/${job.id}/output`,
          {
            headers: {
              origin,
              authorization: `Bearer ${ownerToken}`,
              ...headers,
            },
          },
        ),
      );
    const full = await send();
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-length")).toBe(String(output.byteLength));
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(output);
    const partial = await send({ range: "bytes=1048570-1048580" });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(
      `bytes 1048570-1048580/${output.byteLength}`,
    );
    expect(partial.headers.get("content-length")).toBe("11");
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(
      output.subarray(1048570, 1048581),
    );
    const suffix = await send({ range: "bytes=-5" });
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(
      output.subarray(output.byteLength - 5),
    );
    const invalid = await send({ range: "bytes=99999999-" });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe(
      `bytes */${output.byteLength}`,
    );
    const head = await app()(
      new Request(
        `https://api.example/v1/cloud-export/jobs/${job.id}/output`,
        {
          method: "HEAD",
          headers: { origin, authorization: `Bearer ${ownerToken}` },
        },
      ),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("rejects output before success and for another owner", async () => {
    const { job } = await queuedJob();
    const early = await app()(
      new Request(
        `https://api.example/v1/cloud-export/jobs/${job.id}/output`,
        { headers: { origin, authorization: `Bearer ${ownerToken}` } },
      ),
    );
    expect(early.status).toBe(409);
    const foreign = await app()(
      new Request(
        `https://api.example/v1/cloud-export/jobs/${randomUUID()}/output`,
        { headers: { origin, authorization: `Bearer ${ownerToken}` } },
      ),
    );
    expect(foreign.status).toBe(404);
  });

  it("discards only incomplete bytes", async () => {
    const id = randomUUID();
    const data = bytes(1000);
    await pg.query(
      "INSERT INTO axfluxo_export.blobs(id,owner_id,kind,size,sha256,chunk_size,chunk_count) VALUES($1,$2,'video',1000,$3,1048576,1)",
      [id, owner, sha(data)],
    );
    await discardBlob(db, owner, id);
    const found = await pg.query<{ n: string }>(
      "SELECT count(*) AS n FROM axfluxo_export.blobs WHERE id=$1",
      [id],
    );
    expect(Number(found.rows[0].n)).toBe(0);
    const ready = await upload("image", bytes(2048, 5));
    await discardBlob(db, owner, ready.body.blob.id);
    const kept = await pg.query<{ n: string }>(
      "SELECT count(*) AS n FROM axfluxo_export.blobs WHERE id=$1",
      [ready.body.blob.id],
    );
    expect(Number(kept.rows[0].n)).toBe(1);
  });
});

describe("cloud export retention, deletion and tickets", () => {
  it("enforces the owner byte quota before writing", async () => {
    const total = Number(
      (
        await pg.query(
          "SELECT coalesce(sum(size),0) AS total FROM axfluxo_export.blobs WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].total,
    );
    const size = 2 * 1024 * 1024;
    await expect(
      beginBlob(
        db,
        owner,
        { id: randomUUID(), kind: "video", size, sha256: "a".repeat(64) },
        total + 1024 * 1024,
      ),
    ).rejects.toThrow();
    const allowed = await beginBlob(
      db,
      owner,
      { id: randomUUID(), kind: "video", size, sha256: "b".repeat(64) },
      total + 3 * 1024 * 1024,
    );
    expect(allowed.duplicate).toBeNull();
  });

  it("deletes a terminal job and its unreferenced bytes", async () => {
    const video = await upload("video", bytes(4096, 3));
    const cover = await upload("image", bytes(512, 5));
    const created = await app()(
      post(
        "/v1/cloud-export/jobs",
        jobBody({
          clips: [
            {
              blobId: video.body.blob.id,
              startUs: 0,
              endUs: 2_000_000,
              markersUs: [],
            },
          ],
          names: ["only version"],
          coverBlobId: cover.body.blob.id,
        }),
      ),
    );
    expect(created.status).toBe(202);
    const job = (await created.json()) as { id: string };
    const headers = { origin, authorization: `Bearer ${ownerToken}` };
    const busy = await app()(
      new Request(`https://api.example/v1/cloud-export/jobs/${job.id}`, {
        method: "DELETE",
        headers,
      }),
    );
    expect(busy.status).toBe(409);
    expect(
      (
        await app()(
          new Request(
            `https://api.example/v1/cloud-export/jobs/${job.id}/cancel`,
            { method: "POST", headers },
          ),
        )
      ).status,
    ).toBe(200);
    const removed = await app()(
      new Request(`https://api.example/v1/cloud-export/jobs/${job.id}`, {
        method: "DELETE",
        headers,
      }),
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true });
    const gone = await app()(
      new Request(`https://api.example/v1/cloud-export/jobs/${job.id}`, {
        headers,
      }),
    );
    expect(gone.status).toBe(404);
  });

  it("serves a succeeded output once through a single-use ticket", async () => {
    const data = bytes(2048, 11);
    const sha256 = sha(data);
    const blobId = randomUUID();
    await storeBlob(
      workerDb,
      owner,
      {
        id: blobId,
        kind: "output",
        sha256,
        size: data.byteLength,
        chunks: (async function* () {
          yield data;
        })(),
      },
      256 * 1024 ** 2,
    );
    const jobId = randomUUID();
    await pg.query(
      "INSERT INTO axfluxo_export.jobs(id,owner_id,idempotency_key,request_hash,spec,spec_hash,total_frames,state,progress_frame,output_blob_id,output_validation,finished_at) VALUES($1,$2,$3,$4,'{}'::jsonb,$4,60,'succeeded',60,$5,$6::jsonb,now())",
      [
        jobId,
        owner,
        `ticket-${jobId}`,
        "0".repeat(64),
        blobId,
        JSON.stringify({
          width: 1920,
          height: 1080,
          frames: 60,
          durationUs: 1_000_000,
          size: data.byteLength,
          sha256,
        }),
      ],
    );
    const ticket = await app()(
      new Request(
        `https://api.example/v1/cloud-export/jobs/${jobId}/download-ticket`,
        {
          method: "POST",
          headers: { origin, authorization: `Bearer ${ownerToken}` },
        },
      ),
    );
    expect(ticket.status).toBe(200);
    const { url } = (await ticket.json()) as { url: string };
    expect(url).toMatch(/^\/v1\/cloud-export\/downloads\/[A-Za-z0-9_-]{43}$/);
    const download = await app()(new Request(`https://api.example${url}`));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(data);
    const replay = await app()(new Request(`https://api.example${url}`));
    expect(replay.status).toBe(404);
  });

  it("sweeps expired jobs of any owner but not fresh ones", async () => {
    const video = await upload("video", bytes(1024, 13));
    const cover = await upload("image", bytes(256, 17));
    const created = await app()(
      post(
        "/v1/cloud-export/jobs",
        jobBody({
          clips: [
            {
              blobId: video.body.blob.id,
              startUs: 0,
              endUs: 1_000_000,
              markersUs: [],
            },
          ],
          names: ["sweep"],
          coverBlobId: cover.body.blob.id,
        }),
      ),
    );
    const job = (await created.json()) as { id: string };
    await pg.query(
      "UPDATE axfluxo_export.jobs SET state='cancelled',error_code='EXPORT_CANCELLED',finished_at=now() WHERE id=$1",
      [job.id],
    );
    expect(await purgeExpired(workerDb, 24)).toBe(0);
    await pg.query(
      "UPDATE axfluxo_export.jobs SET finished_at=now()-interval '3 hours' WHERE id=$1",
      [job.id],
    );
    expect(await purgeExpired(workerDb, 1)).toBeGreaterThan(0);
    await expect(getJob(db, owner, job.id)).rejects.toThrow();
  });
});
