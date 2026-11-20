import type { StorageRole } from "../../../src/domain/storage/destinations";
import { blompPolicy } from "../../storage/blomp-policy";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createVideoApi } from "../../api/app";
import { blompRouter } from "../../api/blomp/router";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { jwtVerifier } from "../../api/auth";
import { UploadError } from "../../../src/services/cloud-library/upload";
import { ApiError } from "../../api/errors";
import { BlompError, type BlompStorage } from "../../storage/blomp";
import { testEngine } from "../engine";
import { blompPartSize } from "../../../src/domain/blomp/storage";
import { createVideoApiClient } from "../../../src/services/video/api-client";
import {
  blompClient,
  uploadBlomp,
  importBlompSource,
} from "../../../src/services/blomp/client";

const engine = testEngine("memory://");
const location = "blomp-v1:mock";
const owner = randomUUID(),
  other = randomUUID();
const bytes = new Uint8Array(1024).fill(7);
const hash = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const metadata = {
  role: "originals",
  name: "test.mp4",
  mime: "video/mp4",
  size: bytes.length,
  sha256: hash(bytes),
  projectId: null,
  jobId: null,
} as const;
const quota = "axfluxo_video.blomp_capacity";
let writes = true;
let fileLimit: number | null = 5368709120;
let target = location;
let uploads: Map<string, Uint8Array>;
let objects: Map<string, Uint8Array>;
let createLost = false,
  completeLost = false,
  failAbort = false,
  revoke = false;
const verify = async (token: string | null) => {
  if (!token || ![owner, other].some((id) => token === "Bearer " + id))
    throw new ApiError(401, "AUTH_REQUIRED");
  return { ownerId: token.slice(7) };
};
type Ref = Parameters<BlompStorage["head"]>[0];
const storage = {
  get location() {
    return target;
  },
  newReference: (role: StorageRole, id: string): Ref => ({
    provider: "blomp",
    location: target,
    key: `axfluxo/${role}/${id}/${randomUUID()}`,
  }),
  create: vi.fn(async (ref: Ref) => {
    uploads.set(ref.key, new Uint8Array());
    if (createLost) throw Error("private failure");
    return ref.key;
  }),
  findUploads: async (ref: Ref) => (uploads.has(ref.key) ? [ref.key] : []),
  parts: async (ref: Ref, id: string) => {
    expect(id).toBe(ref.key);
    const part = uploads.get(ref.key);
    if (!part?.length) return [];
    return Array.from(
      { length: Math.ceil(part.length / blompPartSize) },
      (_, i) => ({
        number: i + 1,
        size: Math.min(blompPartSize, part.length - i * blompPartSize),
        etag: `opaque-${i}`,
      }),
    );
  },
  sign: vi.fn(async (ref: Ref, operation: "GET" | "HEAD" | "PART") => {
    if (revoke)
      await engine.query(
        "UPDATE axfluxo_video.developer_memberships SET active=false WHERE owner_id=$1",
        [owner],
      );
    return {
      url: `https://storage.blomp.com/fake/${ref.key}?operation=${operation}`,
      expiresAt: Date.now() + 60000,
    };
  }),
  complete: vi.fn(async (ref: Ref) => {
    objects.set(ref.key, uploads.get(ref.key)!);
    uploads.delete(ref.key);
    if (completeLost) throw Error("lost completion");
  }),
  abort: vi.fn(async (ref: Ref) => {
    if (failAbort) throw Error("unknown abort result");
    uploads.delete(ref.key);
  }),
  head: async (ref: Ref) =>
    objects.has(ref.key)
      ? { size: objects.get(ref.key)!.length, etag: "opaque" }
      : null,
  stream: async (ref: Ref) =>
    (async function* () {
      yield objects.get(ref.key)!;
    })(),
};
const app = createVideoApi({
  db: engine.asRole("axfluxo_video_api"),
  verify,
  allowedOrigins: ["https://editor.test"],
  admissionEnabled: () => false,
  blomp: blompRouter({
    db: engine.asRole("axfluxo_video_api"),
    storage,
    policy: {
      ...blompPolicy({
        BLOMP_MAX_FILE_BYTES: "5368709120",
        BLOMP_MULTIPART_ENABLED: "true",
        BLOMP_BROWSER_TRANSFER_ENABLED: "true",
        BLOMP_FREE_LIMITS_CONFIRMED: "true",
      }),
      get maxFileBytes() {
        return fileLimit;
      },
    },
    writes: () => writes,
    verify,
  }),
});
const root = "https://editor-api.test/storage/blomp";
async function call(
  path: string,
  data?: unknown,
  as: string | null = owner,
  key = randomUUID(),
) {
  return app(
    new Request(root + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        ...(as ? { authorization: "Bearer " + as } : {}),
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
  );
}
async function start(
  data: import("../../../src/domain/blomp/storage").BlompStart = metadata,
) {
  const response = await call("/files", data);
  expect(response.status).toBe(201);
  return (await response.json()).id as string;
}
async function resume(id: string) {
  const response = await call(`/files/${id}/resume`, {});
  expect(response.status).toBe(200);
  return [...uploads.keys()].at(-1)!;
}
const counts = async () => {
  const { rows } = await engine.query(
    `SELECT reserved,committed FROM ${quota} WHERE location=$1`,
    [location],
  );
  return [Number(rows[0].reserved), Number(rows[0].committed)];
};
beforeAll(async () => {
  for (const migration of [
    "001_video_foundation",
    "002_cloud_library",
    "003_video_preview",
    "004_video_render",
    "005_all_versions_projects",
    "008_blomp_storage",
    "009_blomp_file_roles",
  ])
    await engine.exec(
      await readFile(
        new URL(`../../db/migrations/${migration}.sql`, import.meta.url),
        "utf8",
      ),
    );
  for (const id of [owner, other])
    await engine.query(
      "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true)",
      [id],
    );
}, 30000);
beforeEach(async () => {
  vi.clearAllMocks();
  writes = true;
  target = location;
  fileLimit = 5368709120;
  createLost = completeLost = failAbort = revoke = false;
  uploads = new Map();
  objects = new Map();
  await engine.exec(
    "TRUNCATE axfluxo_video.blomp_files,axfluxo_video.blomp_capacity,axfluxo_video.blomp_requests",
  );
  await engine.query(
    `INSERT INTO ${quota}(location,capacity,measured_used,margin,upload_remaining,download_remaining,verification_remaining,observed_at) VALUES($1,$2,0,0,$2,$2,$2,now())`,
    [location, 64 * 1024 ** 2],
  );
  await engine.exec(
    "UPDATE axfluxo_video.developer_memberships SET active=true",
  );
});
afterAll(() => engine.close());

it("reserves once, verifies content, and authorizes read by exact owner and location", async () => {
  const id = await start();
  expect((await call("/files", metadata)).status).toBe(200);
  expect(await counts()).toEqual([1024, 0]);
  expect((await call(`/files/${id}/download`, {})).status).toBe(409);
  const object = await resume(id);
  expect((await call(`/files/${id}/part`, { number: 2 })).status).toBe(400);
  uploads.set(object, bytes);
  for (let i = 0; i < 2; i++) {
    const response = await call(`/files/${id}/complete`, {});
    expect((await response.json()).status).toBe("ready");
  }
  expect(await counts()).toEqual([0, 1024]);
  expect(
    (await call(`/files/${id}/download`, {})).headers.get("cache-control"),
  ).toBe("no-store");
  expect((await call(`/files/${id}/download`, {}, other)).status).toBe(404);
  expect((await call(`/files/${id}/resume`, {}, other)).status).toBe(404);
  expect((await call(`/files/${id}`, undefined, null)).status).toBe(401);
  expect((await (await call("/files", undefined, other)).json()).files).toEqual(
    [],
  );
  target = "other-location";
  expect((await call(`/files/${id}`)).status).toBe(404);
});

it("holds unknown, stale, disabled, and concurrently oversubscribed capacity", async () => {
  writes = false;
  expect((await call("/files", metadata)).status).toBe(503);
  writes = true;
  await engine.exec(
    `UPDATE ${quota} SET observed_at=now()-interval '16 minutes'`,
  );
  expect((await call("/files", metadata)).status).toBe(503);
  await engine.exec(`UPDATE ${quota} SET observed_at=now(),capacity=1024`);
  const responses = await Promise.all([
    call("/files", metadata),
    call("/files", { ...metadata, name: "second.mp4" }, other),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 503]);
  await engine.exec(`UPDATE ${quota} SET measured_used=512`);
  const files = (await (await call("/files")).json()).files;
  if (files[0])
    expect((await call(`/files/${files[0].id}/resume`, {})).status).toBe(503);
  target = "no-snapshot";
  expect((await call("/files", metadata)).status).toBe(503);
});

it("reconciles lost create and completion results without repeating either call", async () => {
  const id = await start();
  createLost = true;
  expect((await call(`/files/${id}/resume`, {})).status).toBe(503);
  const object = await resume(id);
  expect(storage.create).toHaveBeenCalledTimes(1);
  uploads.set(object, bytes);
  completeLost = true;
  expect((await call(`/files/${id}/complete`, {})).status).toBe(503);
  expect((await (await call(`/files/${id}/complete`, {})).json()).status).toBe(
    "ready",
  );
  expect(storage.complete).toHaveBeenCalledTimes(1);
});

it("quarantines bad hashes, rejects bad part sizes and holds ambiguous cancellation", async () => {
  const id = await start();
  const object = await resume(id);
  uploads.set(object, bytes.slice(1));
  expect((await call(`/files/${id}/complete`, {})).status).toBe(409);
  uploads.set(object, new Uint8Array(bytes.length));
  expect((await (await call(`/files/${id}/complete`, {})).json()).status).toBe(
    "failed",
  );
  expect((await call(`/files/${id}/download`, {})).status).toBe(409);
  const next = await start({ ...metadata, name: "cancel.mp4" });
  await resume(next);
  failAbort = true;
  expect((await call(`/files/${next}/cancel`, {})).status).toBe(503);
  expect(await counts()).toEqual([2048, 0]);
  failAbort = false;
  expect((await (await call(`/files/${next}/cancel`, {})).json()).status).toBe(
    "cancelled",
  );
  expect(await counts()).toEqual([1024, 0]);
});

it("refuses caller storage coordinates, oversized bodies, revoked and replayed signing", async () => {
  for (const key of [
    "ownerId",
    "objectKey",
    "bucket",
    "url",
    "provider",
    "location",
    "uploadId",
  ])
    expect(
      (await call("/files", { ...metadata, [key]: "invalid" })).status,
    ).toBe(400);
  expect(
    (await call("/files", { ...metadata, name: "x".repeat(5000) })).status,
  ).toBe(413);
  const id = await start();
  const object = await resume(id);
  expect((await call(`/files/${id}/part`, { number: 1 })).status).toBe(200);
  expect((await call(`/files/${id}/cancel`, {})).status).toBe(409);
  revoke = true;
  const denied = await call(`/files/${id}/part`, { number: 1 });
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain(object);
});

it("transfers multiple slices, reselects by SHA and produces a verified output", async () => {
  const session = {
    getSession: async () => ({
      data: {
        session: { access_token: owner, expires_at: Date.now() / 1000 + 3600 },
      },
      error: null,
    }),
    refreshSession: async () => ({ data: { session: null }, error: null }),
  };
  const api = blompClient(
    createVideoApiClient({
      baseUrl: "https://editor-api.test",
      session,
      fetch: (url, init) => app(new Request(url, init)),
    }),
  );
  const blob = new Blob([new Uint8Array(blompPartSize), bytes], {
    type: "video/mp4",
  });
  const sizes: number[] = [],
    progress: number[] = [];
  const transfer = async (url: string, part: Blob) => {
    const key = new URL(url).pathname.slice("/fake/".length);
    const existing = uploads.get(key)!;
    const joined = new Uint8Array(existing.length + part.size);
    joined.set(existing);
    joined.set(new Uint8Array(await part.arrayBuffer()), existing.length);
    uploads.set(key, joined);
    sizes.push(part.size);
  };
  const input = {
    name: "output.mp4",
    role: "outputs",
    mime: "video/mp4",
    projectId: null,
    jobId: null,
  } as const;
  const controller = new AbortController();
  await expect(
    uploadBlomp({
      api,
      blob,
      input,
      signal: controller.signal,
      progress: (n) => progress.push(n),
      transfer: async (url, part) => {
        if (sizes.length === 0 && storage.sign.mock.calls.length === 1)
          throw new UploadError("UPLOAD_SIGNATURE_EXPIRED");
        await transfer(url, part);
        controller.abort();
      },
    }),
  ).rejects.toThrow();
  const listing = await api.list();
  const file = listing.ok ? listing.data.files[0] : undefined;
  expect(file?.status).toBe("interrupted");
  await expect(
    uploadBlomp({
      api,
      blob: new Blob([new Uint8Array(blob.size)], { type: "video/mp4" }),
      input,
      resumeId: file!.id,
      signal: new AbortController().signal,
      progress: () => {},
      transfer,
    }),
  ).rejects.toThrow("UPLOAD_FILE_MISMATCH");
  const ready = await uploadBlomp({
    api,
    blob,
    input,
    resumeId: file!.id,
    signal: new AbortController().signal,
    progress: (n) => progress.push(n),
    transfer,
  });
  expect(ready.status).toBe("ready");
  expect(sizes).toEqual([blompPartSize, 1024]);
  expect(storage.sign).toHaveBeenCalledTimes(3);
  expect(progress.at(-1)).toBe(blob.size);
}, 15000);

it("accounts for each signature and refuses transfer when the budget is exhausted", async () => {
  const id = await start();
  await resume(id);
  await engine.exec(`UPDATE ${quota} SET upload_remaining=1024`);
  expect((await call(`/files/${id}/part`, { number: 1 })).status).toBe(200);
  expect((await call(`/files/${id}/part`, { number: 1 })).status).toBe(503);
  expect(await counts()).toEqual([1024, 0]);
  const rows = await engine
    .asRole("axfluxo_video_api")
    .transaction(async (sql) => {
      await sql.query("SELECT set_config('axfluxo.owner_id',$1,true)", [other]);
      return (
        await sql.query(
          "SELECT id FROM axfluxo_video.blomp_files WHERE id=$1",
          [id],
        )
      ).rows;
    });
  expect(rows).toEqual([]);
});

it("rejects an expired signed JWT before the catalog is consulted", async () => {
  const issuer = "https://auth.test";
  const { publicKey, privateKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const verify = jwtVerifier(
    createLocalJWKSet({ keys: [await exportJWK(publicKey)] }),
    { issuer, audience: "authenticated" },
  );
  const route = vi.fn();
  const authenticated = createVideoApi({
    db: engine.asRole("axfluxo_video_api"),
    verify,
    allowedOrigins: ["https://editor.test"],
    admissionEnabled: () => false,
    blomp: route,
  });
  const expired = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(issuer)
    .setAudience("authenticated")
    .setSubject(owner)
    .setIssuedAt()
    .setExpirationTime(1)
    .sign(privateKey);
  const response = await authenticated(
    new Request(root + "/files", {
      headers: { authorization: "Bearer " + expired },
    }),
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: { code: "AUTH_EXPIRED" } });
  expect(route).not.toHaveBeenCalled();
});

it("imports a bounded verified original and rejects an altered or oversized download", async () => {
  const id = await start();
  const object = await resume(id);
  uploads.set(object, bytes);
  const file = await (await call(`/files/${id}/complete`, {})).json();
  const session = {
    getSession: async () => ({
      data: {
        session: { access_token: owner, expires_at: Date.now() / 1000 + 3600 },
      },
      error: null,
    }),
    refreshSession: async () => ({ data: { session: null }, error: null }),
  };
  const api = blompClient(
    createVideoApiClient({
      baseUrl: "https://editor-api.test",
      session,
      fetch: (url, init) => app(new Request(url, init)),
    }),
  );
  const transport = vi.fn(async () => new Response(bytes));
  const imported = await importBlompSource(api, file, 1024, transport);
  expect(imported.name).toBe(metadata.name);
  expect(imported.size).toBe(1024);
  await expect(importBlompSource(api, file, 1023, transport)).rejects.toThrow(
    "INVALID_RESPONSE",
  );
  expect(transport).toHaveBeenCalledTimes(1);
  await expect(
    importBlompSource(
      api,
      file,
      1024,
      async () => new Response(new Uint8Array(1024)),
    ),
  ).rejects.toThrow("UPLOAD_FILE_MISMATCH");
});

it("holds unknown provider limits and stops new uploads when the limit is lowered", async () => {
  fileLimit = null;
  const overview = await (await call("/overview")).json();
  expect(overview.state).toBe("held");
  expect(overview.capabilities).toEqual({
    multipartWrites: false,
    maxFileBytes: null,
  });
  expect((await call("/files", metadata)).status).toBe(503);
  fileLimit = 512;
  const blocked = await call("/files", metadata);
  expect(blocked.status).toBe(413);
  expect(await counts()).toEqual([0, 0]);
  fileLimit = 1024;
  await start();
});

it("does not sign more parts after a lowered limit or reinterpret an old account reference", async () => {
  const id = await start();
  await resume(id);
  fileLimit = 512;
  expect((await call(`/files/${id}/part`, { number: 1 })).status).toBe(413);
  expect((await call(`/files/${id}/resume`, {})).status).toBe(413);
  expect((await call(`/files/${id}/complete`, {})).status).toBe(413);
  expect(storage.sign).not.toHaveBeenCalled();
  expect(storage.complete).not.toHaveBeenCalled();
  expect(await counts()).toEqual([1024, 0]);
  target = "other-location";
  expect((await call(`/files/${id}`)).status).toBe(404);
  target = location;
  expect((await call(`/files/${id}`)).status).toBe(200);
});

it("returns distinct safe provider failures without issuing access or releasing a reservation", async () => {
  const id = await start();
  await resume(id);
  for (const code of [
    "BLOMP_AUTH_EXPIRED",
    "BLOMP_AUTH_FAILED",
    "BLOMP_ACCOUNT_UNAVAILABLE",
    "BLOMP_CAPACITY_HELD",
    "BLOMP_RATE_LIMITED",
  ]) {
    storage.sign.mockRejectedValueOnce(new BlompError(code));
    const response = await call(`/files/${id}/part`, { number: 1 });
    expect(response.status).toBe(code === "BLOMP_RATE_LIMITED" ? 429 : 503);
    expect(await response.json()).toEqual({ error: { code } });
  }
  expect(await counts()).toEqual([1024, 0]);
});

it.each(["inputs", "intermediates", "checkpoints"] as const)(
  "stores and retrieves a %s file with its original provider",
  async (role) => {
    const data = {
      ...metadata,
      role,
      mime: role === "checkpoints" ? "application/json" : metadata.mime,
    } as const;
    const id = await start(data);
    const key = await resume(id);
    expect(key).toContain(`axfluxo/${role}/`);
    uploads.set(key, bytes);
    const completed = await call(`/files/${id}/complete`, {});
    expect(await completed.json()).toMatchObject({
      id,
      role,
      provider: "blomp",
      status: "ready",
    });
    const listing = await (await call("/files")).json();
    expect(listing.files).toEqual([
      expect.objectContaining({ id, role, provider: "blomp", status: "ready" }),
    ]);
    expect((await call(`/files/${id}/download`, {})).status).toBe(200);
  },
);
it("rejects an opaque checkpoint MIME outside the checkpoint category", async () => {
  expect(
    (await call("/files", { ...metadata, mime: "application/octet-stream" }))
      .status,
  ).toBe(400);
  expect(await counts()).toEqual([0, 0]);
});
