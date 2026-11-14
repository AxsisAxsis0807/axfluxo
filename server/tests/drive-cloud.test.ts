import { execFileSync } from "node:child_process";
import { DriveCloud as CloudService } from "../drive-cloud/service";
import { driveCloudRouter, byteRange } from "../drive-cloud/router";
import { createVideoApi } from "../api/app";
import { claim, finishFailure } from "../worker/jobs/queue";
import { executeRender } from "../worker/render/service";
import { driveRenderStorage } from "../drive-cloud/storage";
import { singleThreaded, threadArguments } from "../drive-cloud/resources";
import { newProject } from "../../src/domain/video/all-versions";
import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import { readFile, readdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { testEngine, type TestEngine } from "./engine";
import { DriveCloud } from "../drive-cloud/service";
import { DriveTransfer, uploadUrl, DRIVE_CHUNK } from "../drive-cloud/transfer";
import { drivePolicy, maxVerifiableDriveBytes } from "../drive-cloud/config";
import { driveCredentials } from "../drive-cloud/credentials";
import { GoogleDrive } from "../google-drive/google";
import { tokenVault, sha256 } from "../google-drive/security";
const owner = randomUUID(),
  other = randomUUID(),
  key = Buffer.alloc(32, 11).toString("base64"),
  vault = tokenVault(key);
const objects = new Map<
    string,
    { data: Buffer; meta: Record<string, unknown> }
  >(),
  sessions = new Map<
    string,
    {
      id: string;
      offset: number;
      data: Buffer[];
      meta: Record<string, unknown>;
    }
  >();
let pg: TestEngine,
  dir: string,
  serial = 0,
  lost = false,
  quota = 100 * 1024 ** 2,
  denyToken = false;
const transport: typeof fetch = async (input, init) => {
  const u = new URL(String(input));
  if (u.hostname === "oauth2.googleapis.com") {
    if (denyToken)
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({
      access_token: "mock-access",
      refresh_token: "mock-rotated",
      expires_in: 3600,
    });
  }
  if (u.pathname.endsWith("/about"))
    return Response.json({
      user: { permissionId: "account" },
      storageQuota: { limit: String(quota), usage: "0" },
    });
  if (u.pathname.endsWith("/generateIds"))
    return Response.json({
      ids: Array.from(
        { length: Number(u.searchParams.get("count")) },
        () => `file-${++serial}`,
      ),
    });
  if (u.pathname === "/upload/drive/v3/files" && init?.method === "POST") {
    const meta = JSON.parse(String(init.body)),
      id = "session-" + ++serial;
    sessions.set(id, { id: meta.id, offset: 0, data: [], meta });
    return new Response(null, {
      status: 200,
      headers: {
        location:
          "https://www.googleapis.com/upload/drive/v3/files?upload_id=" + id,
      },
    });
  }
  if (u.pathname === "/upload/drive/v3/files") {
    const session = sessions.get(u.searchParams.get("upload_id")!);
    if (!session) return new Response(null, { status: 404 });
    if (objects.has(session.id)) return Response.json({ id: session.id });
    if (init?.body) {
      const data = Buffer.from(init.body as Uint8Array),
        range = new Headers(init.headers).get("content-range")!;
      expect(range.startsWith("bytes " + session.offset + "-")).toBe(true);
      session.data.push(data);
      session.offset += data.length;
      const size = Number(range.split("/")[1]);
      if (session.offset === size) {
        objects.set(session.id, {
          data: Buffer.concat(session.data),
          meta: {
            ...session.meta,
            size: String(size),
            version: "1",
            headRevisionId: "revision-1",
            trashed: false,
          },
        });
        if (lost) {
          lost = false;
          throw Error("lost final response");
        }
        return Response.json({ id: session.id });
      }
    }
    return new Response(null, {
      status: 308,
      headers: session.offset
        ? { range: "bytes=0-" + (session.offset - 1) }
        : {},
    });
  }
  const id = u.pathname.includes("/revisions/")
      ? u.pathname.split("/")[4]
      : u.pathname.split("/").at(-1)!,
    file = objects.get(id);
  if (["root", "queue", "completed"].includes(id))
    return Response.json({
      id,
      mimeType: "application/vnd.google-apps.folder",
      parents: id === "root" ? [] : ["root"],
      appProperties: {
        axfluxoOwner: owner,
        axfluxoRole: id === "root" ? "root" : id,
      },
    });
  if (!file) return Response.json({}, { status: 404 });
  if (u.searchParams.get("alt") === "media") {
    const range = new Headers(init?.headers).get("range");
    if (range) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      return new Response(
        new Uint8Array(file.data.subarray(Number(m[1]), Number(m[2]) + 1)),
        {
          status: 206,
          headers: {
            "content-range": `bytes ${m[1]}-${m[2]}/${file.data.length}`,
          },
        },
      );
    }
    return new Response(new Uint8Array(file.data));
  }
  return Response.json(file.meta);
};
const google = new GoogleDrive(
  {
    clientId: "mock",
    clientSecret: "dummy",
    callback: "https://api.test/api/integrations/google-drive/callback",
    frontendUrl: "https://ui.test/developer/video/",
    vault,
  },
  transport,
);
const policy = () => ({
  ...drivePolicy({
    NODE_ENV: "test",
    DRIVE_CLOUD_ENABLED: "true",
    DRIVE_CLOUD_TERMS_CONFIRMED: "true",
    DRIVE_CLOUD_MONTHLY_YEN: "0",
    DRIVE_CLOUD_LIMIT_BYTES: String(100 * 1024 ** 2),
    DRIVE_CLOUD_MARGIN_BYTES: "1048576",
    VIDEO_RENDER_DISK: dir,
  }),
  maxWorkBytes: 50 * 1024 ** 2,
  minFreeBytes: 0,
});
const service = () =>
  new DriveCloud(pg.asRole("axfluxo_video_api"), google, policy());
const data = Buffer.alloc(262144, 3);
const reserve = (key = randomUUID()) =>
  service().reserve(owner, {
    key,
    size: data.length,
    hash: sha256(data),
    mime: "video/mp4",
    name: "source.mp4",
  });
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "drive-cloud-"));
  pg = testEngine(join(dir, "db"));
  for (const name of (
    await readdir(new URL("../db/migrations/", import.meta.url))
  )
    .filter((n) => /^\d.*\.sql$/.test(n))
    .sort())
    await pg.exec(
      await readFile(
        new URL("../db/migrations/" + name, import.meta.url),
        "utf8",
      ),
    );
  await pg.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true),($2,true)",
    [owner, other],
  );
});
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await pg.exec(
    "TRUNCATE axfluxo_video.render_batches,axfluxo_video.media_assets,axfluxo_video.media_quotas,axfluxo_video.usage_budgets CASCADE; INSERT INTO axfluxo_video.render_slot(id) VALUES(1) ON CONFLICT DO NOTHING;",
  );

  await pg.query(
    "TRUNCATE axfluxo_video.drive_media_tickets,axfluxo_video.drive_tickets,axfluxo_video.drive_saved,axfluxo_video.drive_usage,axfluxo_video.drive_batches,axfluxo_video.drive_chunks,axfluxo_video.drive_inventory,axfluxo_video.drive_capacity,axfluxo_video.drive_oauth,axfluxo_video.drive_files,axfluxo_video.drive_connections",
  );
  objects.clear();
  sessions.clear();
  lost = false;
  denyToken = false;
  quota = 100 * 1024 ** 2;
  for (const id of [owner, other])
    await pg.query(
      "INSERT INTO axfluxo_video.drive_connections(owner_id,generation,refresh_cipher,root_id,queue_id,completed_id,account_id,connected) VALUES($1,$2,$3,'root','queue','completed','account',true)",
      [id, randomUUID(), vault.seal("mock-refresh", id + ":refresh")],
    );
});
it("fails closed until both the operating gate and <=500 yen confirmation are supplied", () => {
  expect(drivePolicy({ DRIVE_CLOUD_ENABLED: "true" }).enabled()).toBe(false);
  expect(
    drivePolicy({
      NODE_ENV: "test",
      DRIVE_CLOUD_ENABLED: "true",
      DRIVE_CLOUD_TERMS_CONFIRMED: "true",
      DRIVE_CLOUD_MONTHLY_YEN: "501",
    }).enabled(),
  ).toBe(false);
  expect(policy().enabled()).toBe(true);
});
it("discloses that upload size is not worker verification capacity", () => {
  const configured = policy();
  expect(configured.maxFileBytes).toBeGreaterThan(configured.maxWorkBytes);
  expect(maxVerifiableDriveBytes(configured)).toBe(
    configured.maxWorkBytes - configured.marginBytes,
  );
  expect(maxVerifiableDriveBytes({ ...configured, maxWorkBytes: 1 })).toBe(0);
});
it("lists intermediate storage in read-only dry-run without removing files", async () => {
  const reserved = await service().reserve(owner, {
    key: randomUUID(),
    size: data.length,
    hash: sha256(data),
    mime: "video/mp4",
    name: "temporary.mp4",
    namespace: "preview",
  });
  const response = await call("/cleanup-preview");
  expect(response.status).toBe(200);
  const report = await response.json();
  expect(report).toMatchObject({
    dryRun: true,
    deletionEnabled: false,
  });
  expect(report.items).toContainEqual(
    expect.objectContaining({
      id: reserved.id,
      namespace: "preview",
      mayDelete: false,
    }),
  );
  expect((await service().row(owner, reserved.id)).id).toBe(reserved.id);
  const usage = await (await call("/usage")).json();
  expect(usage.temporary).toContainEqual(
    expect.objectContaining({ namespace: "preview", files: 1 }),
  );
});
it("keeps production Cloud OFF until the actual worker resources are verified", () => {
  const env = {
    NODE_ENV: "production",
    DRIVE_CLOUD_ENABLED: "true",
    DRIVE_CLOUD_TERMS_CONFIRMED: "true",
    DRIVE_CLOUD_MONTHLY_YEN: "0",
    DRIVE_CLOUD_DB_LIMIT_BYTES: String(50 * 1024 ** 2),
    VIDEO_DATABASE_TLS: "verify-full",
    VIDEO_DATABASE_CA: "dummy-test-ca",
  };
  expect(drivePolicy(env).enabled()).toBe(false);
  expect(drivePolicy({ ...env, DRIVE_CLOUD_RESOURCES_VERIFIED: "true" }).enabled()).toBe(true);
});
it("validates Google session URLs, rejecting SSRF and secret-bearing arbitrary hosts", () => {
  for (const url of [
    "http://www.googleapis.com/upload/drive/v3/files?upload_id=x",
    "https://evil.test/upload/drive/v3/files?upload_id=x",
    "https://www.googleapis.com/anything?upload_id=x",
    "https://u:p@www.googleapis.com/upload/drive/v3/files?upload_id=x",
  ])
    expect(() => uploadUrl(url)).toThrow();
});
it("uses separate bounded transfer deadlines and honors caller cancellation", async () => {
  const slow = new GoogleDrive(google.config, async (_input, init) => {
    await new Promise((resolve) => setTimeout(resolve, 35));
    if (init?.signal?.aborted) throw Error("aborted");
    return new Response(null, { status: 200 });
  });
  expect((await slow.send("https://www.googleapis.com/test", {}, 100)).ok).toBe(true);
  await expect(slow.send("https://www.googleapis.com/test", {}, 5)).rejects.toMatchObject({
    code: "DRIVE_UNAVAILABLE",
  });
  const controller = new AbortController();
  controller.abort();
  await expect(slow.send("https://www.googleapis.com/test", { signal: controller.signal }, 100)).rejects.toMatchObject({
    code: "DRIVE_UNAVAILABLE",
  });
});
it("reserves once, rejects different payloads, preserves capacity across month changes", async () => {
  const operation = randomUUID(),
    a = await reserve(operation),
    b = await reserve(operation);
  expect(a.id).toBe(b.id);
  await expect(
    service().reserve(owner, {
      key: operation,
      size: 1,
      hash: sha256("x"),
      mime: "video/mp4",
      name: "x",
    }),
  ).rejects.toMatchObject({ status: 409 });
  const c = (await pg.query("SELECT * FROM axfluxo_video.drive_capacity"))
    .rows[0];
  expect(Number(c.reserved_bytes)).toBe(data.length);
  await pg.query(
    "INSERT INTO axfluxo_video.drive_usage(owner_id,event_key,kind,bytes,created_at) VALUES($1,'previous','export',123,now()-interval '1 month')",
    [owner],
  );
  expect(
    Number(
      (
        await pg.query(
          "SELECT reserved_bytes FROM axfluxo_video.drive_capacity",
        )
      ).rows[0].reserved_bytes,
    ),
  ).toBe(data.length);
});
it("stops on provider quota/unknown space without deleting or over-reserving", async () => {
  quota = 1;
  await expect(reserve()).rejects.toMatchObject({ status: 507 });
  expect(objects.size).toBe(0);
  expect(
    (await pg.query("SELECT * FROM axfluxo_video.drive_inventory")).rows,
  ).toHaveLength(0);
});
it("uses authoritative 308 offset, persists encrypted sessions, recovers lost final response", async () => {
  const s = service(),
    a = await reserve();
  const status = await s.status(owner, a.id);
  expect(status.offset).toBe(0);
  const row = await s.row(owner, a.id);
  expect(row.session_cipher).not.toContain("upload_id");
  expect(row.file_id).toBeTruthy();
  lost = true;
  await expect(
    s.chunk(owner, a.id, 0, data, sha256(data)),
  ).rejects.toMatchObject({ status: 503 });
  const retry = await s.status(owner, a.id);
  expect(retry.state).toBe("verifying");
  expect(retry.offset).toBe(data.length);
  expect(objects.size).toBe(1);
  await expect(
    s.chunk(
      owner,
      a.id,
      0,
      Buffer.alloc(data.length, 4),
      sha256(Buffer.alloc(data.length, 4)),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it("restarts an expired session with the same file ID and retains reservations", async () => {
  const s = service(),
    a = await reserve();
  await s.status(owner, a.id);
  const before = await s.row(owner, a.id);
  sessions.clear();
  await s.status(owner, a.id);
  const after = await s.row(owner, a.id);
  expect(after.file_id).toBe(before.file_id);
  expect(Number(after.offset_bytes)).toBe(0);
  expect(sessions.size).toBe(1);
});
it("rejects out-of-order, wrong hash, oversized and non-aligned nonfinal chunks", async () => {
  const s = service(),
    a = await reserve();
  await expect(
    s.chunk(owner, a.id, 0, data, "0".repeat(64)),
  ).rejects.toMatchObject({ status: 422 });
  await expect(
    s.chunk(owner, a.id, 1, data, sha256(data)),
  ).rejects.toMatchObject({ status: 409 });
  const short = Buffer.alloc(7);
  await expect(
    s.chunk(owner, a.id, 0, short, sha256(short)),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    s.chunk(owner, a.id, 0, Buffer.alloc(DRIVE_CHUNK + 1), "0".repeat(64)),
  ).rejects.toMatchObject({ status: 422 });
});
it("isolates owners, protects immutable file IDs and cannot delete inventory", async () => {
  const a = await reserve();
  await expect(service().row(other, a.id)).rejects.toMatchObject({
    status: 404,
  });
  await pg.asRole("axfluxo_video_api").transaction(async (sql) => {
    await sql.query("SELECT set_config('axfluxo.owner_id',$1,true)", [other]);
    expect(
      (await sql.query("SELECT * FROM axfluxo_video.drive_inventory")).rows,
    ).toHaveLength(0);
  });
  await expect(
    pg.asRole("axfluxo_video_api").transaction(async (sql) => {
      await sql.query("SELECT set_config('axfluxo.owner_id',$1,true)", [owner]);
      await sql.query(
        "DELETE FROM axfluxo_video.drive_inventory WHERE owner_id=$1",
        [owner],
      );
    }),
  ).rejects.toThrow();
});
it("reuses access tokens, single-flights concurrent refresh and fails closed after revocation", async () => {
  const db = pg.asRole("axfluxo_video_api");
  let refreshCount = 0;
  const metered = new GoogleDrive(google.config, async (input, init) => {
    if (String(input).includes("oauth2.googleapis.com")) refreshCount++;
    return transport(input, init);
  });
  const get = driveCredentials(db, metered, owner);
  await Promise.all(
    Array.from({ length: 20 }, () => driveCredentials(db, metered, owner)()),
  );
  expect(refreshCount).toBe(1);
  await get();
  expect(refreshCount).toBe(1);
  const row = (
    await pg.query(
      "SELECT refresh_cipher FROM axfluxo_video.drive_connections WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  expect(vault.open(String(row.refresh_cipher), owner + ":refresh")).toBe(
    "mock-rotated",
  );
  // A new connection generation invalidates the cached access token.
  // The existing remote refresh lease must still be honored.
  await pg.query(
    "UPDATE axfluxo_video.drive_connections SET generation=$2,refresh_until=now()+interval '1 minute' WHERE owner_id=$1",
    [owner, randomUUID()],
  );
  await expect(get()).rejects.toMatchObject({ code: "DRIVE_REFRESH_BUSY" });
  await pg.query(
    "UPDATE axfluxo_video.drive_connections SET refresh_until=NULL WHERE owner_id=$1",
    [owner],
  );
  denyToken = true;
  await expect(get()).rejects.toMatchObject({
    code: "DRIVE_RECONNECT_REQUIRED",
  });
  expect(
    (
      await pg.query(
        "SELECT connected FROM axfluxo_video.drive_connections WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].connected,
  ).toBe(false);
});
it("streams a synthetic 1.7 GB object with a fixed 64 KiB buffer", async () => {
  const size = 1700000000,
    block = Buffer.alloc(65536, 1);
  let emitted = 0,
    max = 0;
  const big = new GoogleDrive(
    google.config,
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (emitted === size) {
              controller.close();
              return;
            }
            const length = Math.min(block.length, size - emitted);
            max = Math.max(max, length);
            emitted += length;
            controller.enqueue(block.subarray(0, length));
          },
        }),
      ),
  );
  const transfer = new DriveTransfer(big, async () => "mock");
  let received = 0;
  const h = createHash("sha256");
  for await (const b of (await transfer.stream("synthetic")).body) {
    received += b.length;
    h.update(b);
  }
  expect(received).toBe(size);
  expect(max).toBe(65536);
  expect(h.digest("hex")).toHaveLength(64);
});

const api = () => {
  const router = driveCloudRouter(service(), 1, 1);
  return createVideoApi({
    db: pg.asRole("axfluxo_video_api"),
    verify: async (a) => {
      if (a !== "Bearer mock-user") throw Error();
      return { ownerId: owner };
    },
    allowedOrigins: ["https://ui.test"],
    admissionEnabled: () => true,
    response: router.authenticated,
    public: router.public,
  });
};
const call = (
  path: string,
  body?: unknown,
  operation = randomUUID(),
  headers: Record<string, string> = {},
) =>
  api()(
    new Request("https://api.test/v1/drive" + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: "Bearer mock-user",
        "content-type": "application/json",
        "idempotency-key": operation,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
async function fixture() {
  const source = join(dir, "source.mp4"),
    cover = join(dir, "cover.png");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=blue:s=160x90:r=60:d=0.5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.5",
    "-threads",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-y",
    source,
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=16x16",
    "-frames:v",
    "1",
    "-threads",
    "1",
    "-y",
    cover,
  ]);
  const ready = [];
  for (const [path, mime] of [
    [source, "video/mp4"],
    [cover, "image/png"],
  ]) {
    const bytes = await readFile(path),
      s = service(),
      row = await s.reserve(owner, {
        key: randomUUID(),
        size: bytes.length,
        hash: sha256(bytes),
        mime,
        name: "fixture",
      });
    await s.chunk(owner, row.id, 0, bytes, sha256(bytes));
    expect((await s.row(owner, row.id)).state).toBe("verifying");
    const worker = new CloudService(
      pg.asRole("axfluxo_video_probe"),
      google,
      policy(),
    );
    expect(await worker.verify(owner, row.id)).toBe(true);
    ready.push(s.view(await s.row(owner, row.id)));
  }
  await pg.query(
    "INSERT INTO axfluxo_video.usage_budgets(owner_id,limit_units) VALUES($1,100000)",
    [owner],
  );
  const video = ready[0],
    image = ready[1],
    duration = Number(video.probe!.durationUs);
  const document = {
    schemaVersion: 1,
    kind: "all-versions",
    id: randomUUID(),
    revision: 0,
    clips: [
      {
        id: "clip",
        source: video.reference,
        sourceDurationUs: duration,
        interval: { startUs: 0, endUs: duration },
        markersUs: [],
      },
    ],
    fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
  };
  const snapshot = {
    schemaVersion: 1,
    id: randomUUID(),
    document,
    ranges: [{ startUs: 0, endUs: duration }],
    names: ["output.mp4"],
  };
  return {
    snapshot,
    project: {
      ...newProject(),
      document,
      cover: image.reference,
      namesText: "NORMAL",
    },
  };
}
it("checks byte Range/If-Range semantics without full Blob buffering", () => {
  expect(byteRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
  expect(byteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
  expect(byteRange("bytes=0-999", 10)).toEqual({ start: 0, end: 9 });
  for (const range of ["bytes=99-", "bytes=2-1", "bytes=0-1,3-4", "bytes=-0"])
    expect(() => byteRange(range, 10)).toThrow();
});
it("keeps encoder quality args and scopes single-thread policy to the new Drive task", async () => {
  const args = ["-threads:v", "2", "-crf", "18", "-r:v", "60"];
  expect(threadArguments("ffmpeg", args)).toEqual(args);
  await singleThreaded(async () => {
    expect(threadArguments("ffmpeg", args)).toContain("18");
    expect(threadArguments("ffmpeg", args).at(-1)).toBe("60");
    expect(threadArguments("ffmpeg", args)[7]).toBe("1");
  });
  expect(threadArguments("ffmpeg", args)).toEqual(args);
});
it("worker independently verifies originals, admits immutable snapshots, resumes held job with its reservation", async () => {
  const body = await fixture(),
    operation = randomUUID(),
    response = await call("/batches", body, operation);
  expect(response.status).toBe(202);
  const batch = await response.json();
  expect(batch.workerReady).toBe(true);
  const duplicate = await (await call("/batches", body, operation)).json();
  expect(duplicate.id).toBe(batch.id);
  expect(
    (
      await call(
        "/batches",
        { ...body, snapshot: { ...body.snapshot, id: randomUUID() } },
        operation,
      )
    ).status,
  ).toBe(409);
  const worker = pg.asRole("axfluxo_video_render"),
    c = await claim(worker);
  expect(c!.job).toBe(batch.jobs[0].id);
  await finishFailure(worker, c!, "DISK_FULL");
  const before = (
    await pg.query(
      "SELECT reserved_units FROM axfluxo_video.usage_budgets WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  const resumed = await call("/jobs/" + c!.job + "/resume", {});
  expect(resumed.status).toBe(200);
  expect((await resumed.json()).jobs[0].id).toBe(c!.job);
  expect(
    (
      await pg.query(
        "SELECT reserved_units FROM axfluxo_video.usage_budgets WHERE owner_id=$1",
        [owner],
      )
    ).rows[0],
  ).toEqual(before);
  const c2 = await claim(worker);
  expect(c2!.token).not.toBe(c!.token);
  expect(await finishFailure(worker, c!, "DISK_FULL")).toBe(false);
  await finishFailure(worker, c2!, "DISK_FULL");
});
it("renders a real short 1080p60 All Versions MP4 to mock Drive, meters once and streams ticket ranges", async () => {
  const body = await fixture(),
    response = await call("/batches", body);
  expect(response.status).toBe(202);
  const batch = await response.json(),
    worker = pg.asRole("axfluxo_video_render"),
    c = (await claim(worker))!;
  const result = await singleThreaded(() =>
    executeRender(
      worker,
      driveRenderStorage(
        new CloudService(worker, google, policy()),
        owner,
        c.job,
        null,
      ),
      c,
      {
        directory: dir,
        maxWorkBytes: 50 * 1024 ** 2,
        minFreeBytes: 0,
        segmentFrames: 300,
      },
    ),
  );
  expect(result.state).toBe("succeeded");
  const completed = await (await call("/batches/" + batch.id)).json(),
    output = completed.outputs[0];
  expect(output).toBeTruthy();
  const ticket = await (
    await call("/outputs/" + output.id + "/ticket", {})
  ).json();
  const download = (headers: Record<string, string> = {}, method = "GET") =>
    api()(new Request("https://api.test" + ticket.url, { method, headers }));
  const full = await download();
  expect(full.status).toBe(200);
  const bytes = new Uint8Array(await full.arrayBuffer());
  expect(sha256(bytes)).toBe(ticket.sha256);
  const part = await download({ range: "bytes=0-31" });
  expect(part.status).toBe(206);
  expect((await part.arrayBuffer()).byteLength).toBe(32);
  expect((await download({ range: "bytes=999999999-" })).status).toBe(416);
  expect((await download({}, "HEAD")).headers.get("content-length")).toBe(
    String(bytes.length),
  );
  const notSaved = await call("/outputs/" + output.id + "/saved", {
    versionId: ticket.versionId,
    sha256: ticket.sha256,
    destination: "files",
    opened: false,
  });
  expect(notSaved.status).toBe(400);
  expect(
    (
      await call("/outputs/" + output.id + "/saved", {
        versionId: ticket.versionId,
        sha256: ticket.sha256,
        destination: "files",
        opened: true,
      })
    ).status,
  ).toBe(200);
  const ledger = (
    await pg.query(
      "SELECT * FROM axfluxo_video.drive_usage WHERE kind='export'",
      [],
    )
  ).rows;
  expect(ledger).toHaveLength(1);
  expect(Number(ledger[0].bytes)).toBe(bytes.length);
  const capacity = (
    await pg.query(
      "SELECT reserved_bytes FROM axfluxo_video.drive_capacity WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  expect(Number(capacity.reserved_bytes)).toBe(0);
  expect(objects.size).toBeGreaterThan(2);
}, 60000);
it("renders real short 1080x1920 CFR60 FNF with the existing Japanese font and separate output ID", async () => {
  const source = await fixture(),
    document = source.snapshot.document;
  const { fnfFilenames, FNF_RENDERER, FNF_FONT_HASH } =
    await import("../../src/domain/video/fnf-showcase");
  const snapshot = {
    ...source.snapshot,
    kind: "fnf-showcase-snapshot",
    chartNames: ["日本語譜面"],
    names: fnfFilenames(["日本語譜面"]),
    creationOrders: [0],
    preferences: {
      schemaVersion: 1,
      username: "@tester",
      template: {
        presetWidth: 160,
        presetHeight: 90,
        cropTop: 0,
        cropBottom: 0,
        scale: 1080 / 160,
        rendererVersion: FNF_RENDERER,
        fontHash: FNF_FONT_HASH,
      },
    },
  };
  const response = await call("/batches", { snapshot });
  expect(response.status).toBe(202);
  const batch = await response.json(),
    worker = pg.asRole("axfluxo_video_render"),
    c = (await claim(worker))!;
  const result = await singleThreaded(() =>
    executeRender(
      worker,
      driveRenderStorage(
        new CloudService(worker, google, policy()),
        owner,
        c.job,
        null,
      ),
      c,
      {
        directory: dir,
        maxWorkBytes: 50 * 1024 ** 2,
        minFreeBytes: 0,
        segmentFrames: 300,
      },
    ),
  );
  expect(result.state).toBe("succeeded");
  const v = (
    await pg.query(
      "SELECT validation FROM axfluxo_video.render_artifacts WHERE owner_id=$1",
      [owner],
    )
  ).rows[0].validation as Record<string, unknown>;
  expect(v.width).toBe(1080);
  expect(v.height).toBe(1920);
  expect(v.frames).toBe(30);
  const complete = await (await call("/batches/" + batch.id)).json();
  expect(complete.outputs[0].reference.fileId).not.toBe(
    document.clips[0].source?.fileId,
  );
}, 60000);
it("handles 100 concurrent admission requests without double reservations or quota overbooking", async () => {
  const body = await fixture(),
    responses = await Promise.all(
      Array.from({ length: 100 }, () => call("/batches", body)),
    );
  expect(responses.every((r) => [202, 503].includes(r.status))).toBe(true);
  expect(responses.some((r) => r.status === 202)).toBe(true);
  const cap = (
    await pg.query(
      "SELECT * FROM axfluxo_video.drive_capacity WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  expect(
    Number(cap.used_bytes) + Number(cap.reserved_bytes) + policy().marginBytes,
  ).toBeLessThanOrEqual(Number(cap.limit_bytes));
  const sum = (
    await pg.query(
      "SELECT COALESCE(sum(remaining),0) AS total FROM axfluxo_video.drive_job_capacity WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  expect(Number(sum.total)).toBe(Number(cap.reserved_bytes));
}, 60000);
it("retry of a multi-range Drive batch reserves only one job's peak share", async () => {
  const original = await fixture();
  const duration = original.snapshot.ranges[0].endUs;
  const half = Math.floor(duration / 2);
  const body = {
    ...original,
    snapshot: {
      ...original.snapshot,
      ranges: [
        { startUs: 0, endUs: half },
        { startUs: half, endUs: duration },
      ],
      names: ["part-one.mp4", "part-two.mp4"],
    },
  };
  const accepted = await call("/batches", body);
  expect(accepted.status).toBe(202);
  const batch = await accepted.json();
  expect(batch.jobs).toHaveLength(2);
  // Simulate the existing worker having committed a terminal failure;
  // the DB's capacity release trigger remains the authoritative path.
  await pg.query(
    "UPDATE axfluxo_video.render_jobs SET state='failed' WHERE owner_id=$1 AND id=$2",
    [owner, batch.jobs[0].id],
  );
  const retried = await call("/jobs/" + batch.jobs[0].id + "/retry", {});
  expect(retried.status).toBe(202);
  const result = await retried.json();
  const originalPeak = (
    await pg.query(
      "SELECT peak_bytes FROM axfluxo_video.drive_batches WHERE owner_id=$1 AND batch_id=$2",
      [owner, batch.id],
    )
  ).rows[0].peak_bytes;
  const retryBudget = (
    await pg.query(
      "SELECT remaining FROM axfluxo_video.drive_job_capacity WHERE owner_id=$1 AND job_id=$2",
      [owner, result.job.id],
    )
  ).rows[0].remaining;
  expect(Number(retryBudget)).toBe(Math.ceil(Number(originalPeak) / 2));
}, 60000);
it("holds a corrupt original without registering a ready resource or releasing its retained bytes", async () => {
  const row = await reserve(),
    bad = Buffer.alloc(data.length, 4);
  await service().chunk(owner, row.id, 0, bad, sha256(bad));
  const worker = new CloudService(
    pg.asRole("axfluxo_video_probe"),
    google,
    policy(),
  );
  await expect(worker.verify(owner, row.id)).rejects.toMatchObject({
    code: "DRIVE_INTEGRITY_FAILED",
  });
  const after = await service().row(owner, row.id);
  expect(after.state).toBe("held");
  expect(after.version_id).toBeNull();
  expect(objects.size).toBe(1);
  const cap = (
    await pg.query(
      "SELECT reserved_bytes FROM axfluxo_video.drive_capacity WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  expect(Number(cap.reserved_bytes)).toBe(data.length);
});
it("bootstraps one known folder under 100 concurrent creates without name-based adoption", async () => {
  const folders = new Map<string, Record<string, unknown>>();
  let creates = 0;
  const api = new GoogleDrive(google.config, async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST") {
      const value = JSON.parse(String(init.body));
      if (folders.has(value.id)) return Response.json({}, { status: 409 });
      creates++;
      folders.set(value.id, value);
      return Response.json({ id: value.id });
    }
    const row = folders.get(path.split("/").at(-1)!);
    return row ? Response.json(row) : Response.json({}, { status: 404 });
  });
  await Promise.all(
    Array.from({ length: 100 }, () =>
      api.folder("mock", "reserved-id", "AxFluxo", undefined, owner, "root"),
    ),
  );
  expect(creates).toBe(1);
  expect(folders.size).toBe(1);
  folders.get("reserved-id")!.name = "Renamed";
  await api.folder("mock", "reserved-id", "AxFluxo", undefined, owner, "root");
  expect(creates).toBe(1);
});
it("shares the refresh lease with the retained Phase 1 diagnostic route", async () => {
  const { driveRouter } = await import("../google-drive/router");
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const slow = new GoogleDrive(google.config, async (input, init) => {
    if (String(input).includes("oauth2.googleapis.com")) {
      entered();
      await waiting;
    }
    return transport(input, init);
  });
  const get = driveCredentials(pg.asRole("axfluxo_video_api"), slow, owner),
    pending = get();
  await started;
  const old = driveRouter(pg.asRole("axfluxo_video_api"), slow);
  await expect(
    old.authenticated(
      new Request("https://api.test/api/integrations/google-drive/folders", {
        method: "POST",
      }),
      owner,
    ),
  ).rejects.toMatchObject({ code: "DRIVE_REFRESH_BUSY" });
  release();
  expect(await pending).toBe("mock-access");
});
it("requires verified TLS in production even when the claimed total cost is zero", () => {
  expect(
    drivePolicy({
      NODE_ENV: "production",
      DRIVE_CLOUD_ENABLED: "true",
      DRIVE_CLOUD_TERMS_CONFIRMED: "true",
      DRIVE_CLOUD_MONTHLY_YEN: "0",
      VIDEO_DATABASE_TLS: "disable",
    }).enabled(),
  ).toBe(false);
});
it("generates real Drive preview/waveform/thumbnail with the existing worker and serves private media ranges", async () => {
  const { generatePreview } = await import("../worker/derivatives/service"),
    { drivePreviewStorage } = await import("../drive-cloud/preview");
  const body = await fixture(),
    version = body.snapshot.document.clips[0].source!.versionId;
  const req = () =>
    api()(
      new Request("https://api.test/cloud/versions/" + version + "/preview", {
        method: "POST",
        headers: { authorization: "Bearer mock-user" },
      }),
    );
  expect((await req()).status).toBe(409);
  const db = pg.asRole("axfluxo_video_probe"),
    s = new DriveCloud(db, google, {
      ...policy(),
      maxWorkBytes: 128 * 1024 ** 2,
    });
  expect(
    await singleThreaded(() =>
      generatePreview(
        db,
        drivePreviewStorage(s, owner, version),
        owner,
        version,
      ),
    ),
  ).toBe(true);
  const response = await req();
  expect(response.status).toBe(200);
  const info = await response.json();
  expect(info.durationUs).toBe(500000);
  const waveform = await api()(
    new Request(info.waveform, { headers: { origin: "https://ui.test" } }),
  );
  expect(waveform.status).toBe(200);
  expect(waveform.headers.get("access-control-allow-origin")).toBe(
    "https://ui.test",
  );
  expect((await waveform.json()).hash).toBe(
    body.snapshot.document.clips[0].source!.hash,
  );
  const access = await api()(
    new Request("https://api.test/cloud/versions/" + version + "/access", {
      headers: { authorization: "Bearer mock-user" },
    }),
  );
  expect(access.status).toBe(200);
  const source = await access.json(),
    bytes = await api()(
      new Request(source.url, { headers: { range: "bytes=0-15" } }),
    );
  expect(bytes.status).toBe(206);
  expect((await bytes.arrayBuffer()).byteLength).toBe(16);
}, 60000);
