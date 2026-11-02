import { createVideoApiClient } from "../../../src/services/video/api-client";
import { cloudClient } from "../../../src/services/cloud-library/client";
import {
  uploadFile,
  listResumes,
  type ResumeStorage,
} from "../../../src/services/cloud-library/upload";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { testEngine, type TestEngine } from "../engine";
import { createVideoApi } from "../../api/app";
import { jwtVerifier } from "../../api/auth";
import { cloudRouter } from "../../api/assets/router";
import { UploadService } from "../../api/uploads/service";
import { verifyUpload } from "../../worker/probe/verify";
import { FakeStorage } from "./fake-storage";
let engine: TestEngine,
  store: FakeStorage,
  owner: string,
  other: string,
  auth: string,
  otherAuth: string,
  enabled = true,
  video: Uint8Array,
  alternate: Uint8Array,
  unsupported: Uint8Array;
let keys: Awaited<ReturnType<typeof generateKeyPair>>,
  verify: ReturnType<typeof jwtVerifier>;
const issuer = "https://example.supabase.co/auth/v1";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function token(id: string) {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setSubject(id)
    .setIssuer(issuer)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keys.privateKey);
}
const app = () =>
  createVideoApi({
    db: engine.asRole("axfluxo_video_api"),
    verify,
    allowedOrigins: ["https://editor.test"],
    admissionEnabled: () => false,
    cloud: cloudRouter({
      db: engine.asRole("axfluxo_video_api"),
      storage: store,
      uploadsEnabled: () => enabled,
    }),
  });
async function call(
  path: string,
  body?: unknown,
  bearer = auth,
  key = randomUUID(),
) {
  return app()(
    new Request("https://api.test/cloud" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: "https://editor.test",
        authorization: "Bearer " + bearer,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
async function start(bytes = video, overrides: Record<string, unknown> = {}) {
  const response = await call("/uploads", {
    folderId: null,
    name: "sample.mp4",
    size: bytes.length,
    mime: "video/mp4",
    sha256: hash(bytes),
    ...overrides,
  });
  expect(response.status).toBe(202);
  return response.json();
}
async function put(id: string, bytes = video, bearer = auth) {
  const row = (
    await engine.query<{
      object_key: string;
      multipart_id: string;
      part_size: number;
    }>(
      "SELECT object_key,multipart_id,part_size FROM axfluxo_video.upload_sessions WHERE id=$1",
      [id],
    )
  ).rows[0];
  for (let i = 0; i < bytes.length; i += Number(row.part_size)) {
    const chunk = bytes.subarray(
        i,
        Math.min(i + Number(row.part_size), bytes.length),
      ),
      number = Math.floor(i / Number(row.part_size)) + 1;
    const signed = await call(
      `/uploads/${id}/part`,
      {
        number,
        size: chunk.length,
        sha256: hash(chunk),
        md5: createHash("md5").update(chunk).digest("hex"),
      },
      bearer,
    );
    expect(signed.status).toBe(200);
    store.put(row.multipart_id, number, chunk);
  }
}
async function verified(
  bytes = video,
  overrides: Record<string, unknown> = {},
) {
  const s = await start(bytes, overrides);
  await put(s.id, bytes);
  expect((await call(`/uploads/${s.id}/complete`, {})).status).toBe(202);
  const worker = new UploadService(
    engine.asRole("axfluxo_video_probe"),
    store,
    () => false,
  );
  await verifyUpload(worker, owner, s.id);
  return (await call(`/uploads/${s.id}`)).json();
}
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "axfluxo-cloud-test-"));
  engine = testEngine(join(dir, "db"));
  await engine.exec(
    await readFile(
      new URL("../../db/migrations/001_video_foundation.sql", import.meta.url),
      "utf8",
    ),
  );
  await engine.exec(
    await readFile(
      new URL("../../db/migrations/002_cloud_library.sql", import.meta.url),
      "utf8",
    ),
  );
  const generate = (name: string, color: string, codec = "libx264") => {
    const path = join(dir, name);
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=64x64:r=60:d=0.2`,
        "-c:v",
        codec,
        "-pix_fmt",
        "yuv420p",
        "-y",
        path,
      ],
      { stdio: "ignore" },
    );
    return readFile(path);
  };
  video = await generate("a.mp4", "red");
  alternate = await generate("b.mp4", "blue");
  unsupported = await generate("c.mp4", "yellow", "mpeg4");
  keys = await generateKeyPair("ES256", { extractable: true });
  verify = jwtVerifier(
    createLocalJWKSet({
      keys: [
        { ...(await exportJWK(keys.publicKey)), alg: "ES256", kid: "test" },
      ],
    }),
    { issuer, audience: "authenticated" },
  );
}, 30000);
beforeEach(async () => {
  owner = randomUUID();
  other = randomUUID();
  store = new FakeStorage();
  enabled = true;
  for (const id of [owner, other]) {
    await engine.query(
      "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true)",
      [id],
    );
    await engine.query(
      "INSERT INTO axfluxo_video.media_quotas(owner_id,limit_bytes) VALUES($1,1073741824)",
      [id],
    );
  }
  auth = await token(owner);
  otherAuth = await token(other);
});
afterAll(async () => {
  await engine?.close();
});
describe("cloud library ownership, multipart and verified originals", () => {
  it("uses V1 auth/membership for every cloud route", async () => {
    expect((await call("/folders", undefined, "bad")).status).toBe(401);
    const normal = await token(randomUUID());
    expect((await call("/folders", undefined, normal)).status).toBe(403);
    const s = await start();
    await engine.query(
      "UPDATE axfluxo_video.developer_memberships SET active=false WHERE owner_id=$1",
      [owner],
    );
    for (const path of ["/folders", "/assets", `/uploads/${s.id}`])
      expect((await call(path)).status).toBe(403);
    expect((await call(`/uploads/${s.id}/complete`, {})).status).toBe(403);
  });
  it("seeds exactly two system folders and supports owner-scoped cursor pages", async () => {
    const [a, b] = await Promise.all([
      call("/folders?limit=1"),
      call("/folders?limit=1"),
    ]);
    const first = await a.json();
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    expect((await b.json()).items[0].id).toBe(first.items[0].id);
    const second = await (
      await call(`/folders?limit=1&cursor=${first.nextCursor}`)
    ).json();
    expect(second.items).toHaveLength(1);
    const all = (
      await engine.query(
        "SELECT name FROM axfluxo_video.media_folders WHERE owner_id=$1",
        [owner],
      )
    ).rows.map((r) => r.name);
    expect(all.sort()).toEqual(
      ["All Versions Video Maker", "FNF Showcase Maker"].sort(),
    );
  });
  it("rejects cycles, system-folder moves and another owner's parent", async () => {
    const root = await (
      await call("/folders", { name: "root", parentId: null })
    ).json();
    const child = await (
      await call("/folders", { name: "child", parentId: root.id })
    ).json();
    expect(
      (await call(`/folders/${root.id}/move`, { parentId: child.id })).status,
    ).toBe(409);
    expect(
      (await call(`/folders/${child.id}/move`, { parentId: child.id })).status,
    ).toBe(409);
    expect(
      (
        await call(
          "/folders",
          { name: "foreign", parentId: root.id },
          otherAuth,
        )
      ).status,
    ).toBe(404);
    const system = (await (await call("/folders")).json()).items.find(
      (f: { systemKey: string | null }) => f.systemKey,
    );
    expect(
      (await call(`/folders/${system.id}/move`, { parentId: root.id })).status,
    ).toBe(409);
  });
  it("reserves capacity atomically and leaves only one session on a quota race", async () => {
    await engine.query(
      "UPDATE axfluxo_video.media_quotas SET limit_bytes=$2 WHERE owner_id=$1",
      [owner, video.length],
    );
    const body = {
      folderId: null,
      name: "video.mp4",
      size: video.length,
      mime: "video/mp4",
      sha256: hash(video),
    };
    const responses = await Promise.all([
      call("/uploads", body),
      call("/uploads", body),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
    const q = (
      await engine.query(
        "SELECT reserved_bytes FROM axfluxo_video.media_quotas WHERE owner_id=$1",
        [owner],
      )
    ).rows[0];
    expect(Number(q.reserved_bytes)).toBe(video.length);
  });
  it("fails closed when uploads or storage quota are unconfigured", async () => {
    enabled = false;
    expect(
      (
        await call("/uploads", {
          folderId: null,
          name: "x",
          size: video.length,
          mime: "video/mp4",
          sha256: hash(video),
        })
      ).status,
    ).toBe(503);
    enabled = true;
    await engine.query(
      "UPDATE axfluxo_video.media_quotas SET limit_bytes=NULL WHERE owner_id=$1",
      [owner],
    );
    expect(
      (
        await call("/uploads", {
          folderId: null,
          name: "x",
          size: video.length,
          mime: "video/mp4",
          sha256: hash(video),
        })
      ).status,
    ).toBe(503);
  });
  it("recovers the same session on duplicate start and conflicts on changed bytes", async () => {
    const key = randomUUID(),
      body = {
        folderId: null,
        name: "x.mp4",
        size: video.length,
        mime: "video/mp4",
        sha256: hash(video),
      };
    const a = await (await call("/uploads", body, auth, key)).json(),
      b = await (await call("/uploads", body, auth, key)).json();
    expect(a.id).toBe(b.id);
    expect(store.uploads.size).toBe(1);
    expect(
      (await call("/uploads", { ...body, sha256: "b".repeat(64) }, auth, key))
        .status,
    ).toBe(409);
  });
  it("requires complete provider parts and keeps unverified bytes out of the asset list", async () => {
    const s = await start();
    expect((await call(`/uploads/${s.id}/complete`, {})).status).toBe(409);
    expect((await (await call("/assets")).json()).items).toEqual([]);
    await put(s.id);
    const done = await (await call(`/uploads/${s.id}/complete`, {})).json();
    expect(done.state).toBe("verifying");
    expect((await (await call("/assets")).json()).items).toEqual([]);
  });
  it("handles duplicate complete and a lost complete response without overwriting an object", async () => {
    const s = await start();
    await put(s.id);
    store.loseCompleteResponse = true;
    expect((await call(`/uploads/${s.id}/complete`, {})).status).toBe(503);
    expect((await call(`/uploads/${s.id}/complete`, {})).status).toBe(202);
    expect((await call(`/uploads/${s.id}/complete`, {})).status).toBe(202);
    expect(store.completed).toBe(1);
    expect(store.objects.size).toBe(1);
  });
  it("publishes only after server SHA-256 and real ffprobe, then keeps exact immutable bytes", async () => {
    const s = await verified();
    expect(s.state).toBe("ready");
    const list = (await (await call("/assets")).json()).items;
    expect(list).toHaveLength(1);
    expect(list[0].hash).toBe(hash(video));
    expect((await call(`/versions/${s.versionId}/access`)).status).toBe(200);
    const row = (
      await engine.query(
        "SELECT object_key FROM axfluxo_video.media_versions WHERE id=$1",
        [s.versionId],
      )
    ).rows[0];
    expect(hash(store.objects.get(String(row.object_key))!)).toBe(hash(video));
    await expect(
      engine.query(
        "UPDATE axfluxo_video.media_versions SET hash=$2 WHERE id=$1",
        [s.versionId, "b".repeat(64)],
      ),
    ).rejects.toThrow("immutable");
  });
  it("detects hash mismatch, fake MIME, corruption and unsupported codecs separately", async () => {
    for (const [bytes, overrides, code] of [
      [video, { sha256: "b".repeat(64) }, "HASH_MISMATCH"],
      [video, { mime: "image/png" }, "MIME_MISMATCH"],
      [video.subarray(0, 32), {}, "CORRUPT_MEDIA"],
      [unsupported, {}, "CODEC_UNSUPPORTED"],
    ] as const) {
      const s = await verified(bytes, overrides);
      expect(s.state).toBe("failed");
      expect(s.error).toBe(code);
    }
    expect((await (await call("/assets")).json()).items).toHaveLength(0);
    expect(store.objects.size).toBe(4);
  });
  it("deduplicates verified byte hashes only inside an owner, preserving candidate originals", async () => {
    const a = await verified(),
      b = await verified(video, { name: "different-name.mp4" });
    expect(b.assetId).toBe(a.assetId);
    expect(b.versionId).toBe(a.versionId);
    expect(store.objects.size).toBe(2);
    expect((await (await call("/assets")).json()).items).toHaveLength(1);
  });
  it("allows identical display names with different content and metadata moves/trash/restore", async () => {
    const a = await verified(),
      b = await verified(alternate);
    expect(a.assetId).not.toBe(b.assetId);
    const folder = await (
      await call("/folders", { name: "nested", parentId: null })
    ).json();
    expect(
      (await call(`/assets/${a.assetId}/move`, { folderId: folder.id })).status,
    ).toBe(200);
    expect(
      (
        await call(`/assets/${a.assetId}/rename`, {
          name: "../<script>name.mp4",
        })
      ).status,
    ).toBe(200);
    expect((await call(`/assets/${a.assetId}/trash`, {})).status).toBe(200);
    expect((await call(`/versions/${a.versionId}/access`)).status).toBe(200);
    expect((await call(`/assets/${a.assetId}/restore`, {})).status).toBe(200);
    expect(store.objects.size).toBe(2);
  });
  it("refuses another owner at upload, folder, asset and version boundaries", async () => {
    const s = await verified();
    for (const path of [`/uploads/${s.id}`, `/versions/${s.versionId}/access`])
      expect((await call(path, undefined, otherAuth)).status).toBe(404);
    for (const path of [
      `/uploads/${s.id}/complete`,
      `/uploads/${s.id}/abort`,
      `/assets/${s.assetId}/trash`,
    ])
      expect((await call(path, {}, otherAuth)).status).toBe(404);
    expect(
      (await call(`/assets/${s.assetId}/rename`, { name: "mine" }, otherAuth))
        .status,
    ).toBe(404);
    expect(
      (await (await call("/assets", undefined, otherAuth)).json()).items,
    ).toEqual([]);
  });
  it("aborts only incomplete parts and releases their reservation, never a confirmed original", async () => {
    const s = await start();
    await put(s.id);
    expect((await call(`/uploads/${s.id}/abort`, {})).status).toBe(200);
    expect(store.uploads.size).toBe(0);
    expect(
      Number(
        (
          await engine.query(
            "SELECT reserved_bytes FROM axfluxo_video.media_quotas WHERE owner_id=$1",
            [owner],
          )
        ).rows[0].reserved_bytes,
      ),
    ).toBe(0);
    const ready = await verified();
    expect((await call(`/uploads/${ready.id}/abort`, {})).status).toBe(409);
    expect(store.objects.size).toBe(1);
  });
  it("expires unfinished parts while retaining completed originals past the same deadline", async () => {
    const pending = await start();
    await put(pending.id);
    await engine.query(
      "UPDATE axfluxo_video.upload_sessions SET expires_at=now()-interval '1 day' WHERE id=$1",
      [pending.id],
    );
    expect((await (await call(`/uploads/${pending.id}`)).json()).state).toBe(
      "expired",
    );
    expect(store.uploads.size).toBe(0);
    const ready = await verified();
    await engine.query(
      "UPDATE axfluxo_video.upload_sessions SET expires_at=now()-interval '1 day' WHERE id=$1",
      [ready.id],
    );
    expect((await (await call(`/uploads/${ready.id}`)).json()).state).toBe(
      "ready",
    );
    expect(store.objects.size).toBe(1);
  });
  it("validates immutable part plans after reselection and rejects forged size/part numbers", async () => {
    const s = await start();
    await put(s.id);
    expect(
      (
        await call(`/uploads/${s.id}/part`, {
          number: 1,
          size: video.length,
          sha256: "b".repeat(64),
          md5: createHash("md5").update(video).digest("hex"),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(`/uploads/${s.id}/part`, {
          number: 2,
          size: 1,
          sha256: hash(video),
          md5: "a".repeat(32),
        })
      ).status,
    ).toBe(409);
    const state = await (await call(`/uploads/${s.id}`)).json();
    expect(state.parts[0].etag).toBeTruthy();
  });
  it("resumes after a lost network part and reselects the same bytes before server hash verification", async () => {
    const bytes = Buffer.concat([video, Buffer.alloc(16 * 1024 * 1024)]),
      file = new File([bytes], "resume.mp4", { type: "video/mp4" });
    const map = new Map<string, string>(),
      local: ResumeStorage = {
        get length() {
          return map.size;
        },
        key: (i) => Array.from(map.keys())[i] ?? null,
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => {
          map.set(k, v);
        },
        removeItem: (k) => {
          map.delete(k);
        },
      };
    const session = {
      getSession: async () => ({
        data: {
          session: { access_token: auth, expires_at: Date.now() / 1000 + 3600 },
        },
        error: null,
      }),
      refreshSession: async () => ({ data: { session: null }, error: null }),
    };
    const bridge: typeof fetch = async (input, init) =>
      app()(new Request(String(input), init));
    const client = cloudClient(
      createVideoApiClient({
        baseUrl: "https://api.test",
        session,
        fetch: bridge,
      }),
    );
    let firstDone!: () => void;
    const firstStored = new Promise<void>((resolve) => {
      firstDone = resolve;
    });
    const sent: number[] = [];
    const transport: typeof fetch = async (input, init) => {
      const [upload, number] = new URL(String(input)).pathname
        .slice(1)
        .split("/");
      const part = Number(number);
      sent.push(part);
      if (part === 2) {
        await firstStored;
        throw new TypeError("network disconnected");
      }
      const body = new Uint8Array(await new Response(init!.body).arrayBuffer());
      const etag = store.put(upload, part, body);
      firstDone();
      return new Response(null, { headers: { etag } });
    };
    await expect(
      uploadFile({
        client,
        file,
        ownerId: owner,
        folderId: null,
        storage: local,
        transport,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_INTERRUPTED" });
    const record = listResumes(local, owner)[0];
    expect(record.id).toBeTruthy();
    expect(
      (await (await call(`/uploads/${record.id}`)).json()).parts[0].etag,
    ).toBeTruthy();
    sent.length = 0;
    const resumed: typeof fetch = async (input, init) => {
      const [upload, number] = new URL(String(input)).pathname
        .slice(1)
        .split("/");
      sent.push(Number(number));
      const data = new Uint8Array(await new Response(init!.body).arrayBuffer());
      return new Response(null, {
        headers: { etag: store.put(upload, Number(number), data) },
      });
    };
    const selectedAgain = new File([bytes], "renamed-by-OS.mp4", {
      type: "video/mp4",
      lastModified: 1,
    });
    const result = await uploadFile({
      client,
      file: selectedAgain,
      ownerId: owner,
      folderId: null,
      storage: local,
      resume: record,
      transport: resumed,
    });
    expect(sent).toEqual([2]);
    expect(result.state).toBe("verifying");
    await verifyUpload(
      new UploadService(
        engine.asRole("axfluxo_video_probe"),
        store,
        () => false,
      ),
      owner,
      result.id,
    );
    const ready = await (await call(`/uploads/${result.id}`)).json();
    expect(ready.state).toBe("ready");
    const stored = (
      await engine.query(
        "SELECT hash FROM axfluxo_video.media_versions WHERE id=$1",
        [ready.versionId],
      )
    ).rows[0];
    expect(stored.hash).toBe(hash(bytes));
    expect(Array.from(map.values()).join()).not.toMatch(
      /storage.test|access_token|Bearer/,
    );
  }, 20000);
  it("uses opaque keys for dangerous display filenames, RLS and no cascading original deletion", async () => {
    const s = await verified(video, { name: "../../evil\n<name>.mp4" });
    const row = (
      await engine.query(
        "SELECT object_key,name FROM axfluxo_video.upload_sessions WHERE id=$1",
        [s.id],
      )
    ).rows[0];
    expect(String(row.object_key)).toBe(`originals/${owner}/${s.id}`);
    expect(String(row.name)).not.toContain("\n");
    await engine.asRole("axfluxo_video_api").transaction(async (sql) => {
      await sql.query("SELECT set_config('axfluxo.owner_id',$1,true)", [other]);
      expect(
        (await sql.query("SELECT * FROM axfluxo_video.media_versions")).rows,
      ).toHaveLength(0);
    });
    expect(
      (
        await engine.query(
          "SELECT conname FROM pg_constraint WHERE connamespace='axfluxo_video'::regnamespace AND confdeltype='c'",
        )
      ).rows,
    ).toHaveLength(0);
  });
});
