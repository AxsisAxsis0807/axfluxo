import { beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { testEngine, type TestEngine } from "../engine";
import { FakeStorage } from "../cloud/fake-storage";
import {
  claim,
  heartbeat,
  fenced,
  finishFailure,
  publish,
} from "../../worker/jobs/queue";
import { createBatch, requireMembership } from "../../api/jobs";
import { executeRender } from "../../worker/render/service";
import { renderPlan } from "../../worker/render/plan";
import {
  encodeSegment,
  assemble,
  canCopyAudio,
  type Input,
} from "../../worker/render/encode";
import { probe, fileHash } from "../../worker/render/process";
import { validateVideo } from "../../worker/validation/output";
import {
  fnfSnapshotSchema,
  type FnfSnapshot,
} from "../../../src/domain/video/schema";
import { createVideoApi } from "../../api/app";
import { renderRouter } from "../../api/render";
import { ApiError } from "../../api/errors";
let engine: TestEngine,
  dir: string,
  owner: string,
  storage: Storage,
  source: string,
  snapshot: FnfSnapshot;
class Storage extends FakeStorage {
  failOutput = false;
  lose = false;
  async putRender(key: string, path: string) {
    if (this.failOutput && key.startsWith("render-outputs/"))
      throw Object.assign(
        new Error("secret https://signed.test?token=secret"),
        { $metadata: { httpStatusCode: 503 } },
      );
    if (this.objects.has(key)) throw new Error("immutable");
    this.objects.set(key, await readFile(path));
    if (this.lose) {
      this.lose = false;
      throw new Error("lost response");
    }
  }
}
const worker = () => engine.asRole("axfluxo_video_render");
async function make(name: string, extra: string[] = [], duration = 1) {
  const path = join(dir, name);
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=160x90:rate=60000/1001:duration=${duration}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${duration}`,
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ac",
      "2",
      ...extra,
      "-y",
      path,
    ],
    { stdio: "ignore" },
  );
  return path;
}
async function seed() {
  owner = randomUUID();
  storage = new Storage();
  source = await make(`${owner}.mp4`);
  const bytes = await readFile(source),
    hash = createHash("sha256").update(bytes).digest("hex"),
    asset = randomUUID(),
    version = randomUUID(),
    key = `originals/${owner}/source`;
  storage.objects.set(key, bytes);
  await engine.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true)",
    [owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.usage_budgets(owner_id,limit_units) VALUES($1,1000000000)",
    [owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.media_quotas(owner_id,limit_bytes) VALUES($1,1000000000)",
    [owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.media_assets(id,owner_id,name) VALUES($1,$2,'source')",
    [asset, owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.media_versions(id,owner_id,asset_id,object_key,hash,size,mime,kind,probe) VALUES($1,$2,$3,$4,$5,$6,'video/mp4','video','{}')",
    [version, owner, asset, key, hash, bytes.length],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.resource_versions(owner_id,library_id,file_id,version_id,hash,kind) VALUES($1,'cloud',$2,$3,$4,'video')",
    [owner, asset, version, hash],
  );
  snapshot = fnfSnapshotSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    document: {
      schemaVersion: 1,
      kind: "all-versions",
      id: randomUUID(),
      revision: 0,
      fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
      clips: [
        {
          id: "clip",
          source: {
            libraryId: "cloud",
            fileId: asset,
            versionId: version,
            hash,
            kind: "video",
          },
          sourceDurationUs: 1001000,
          interval: { startUs: 0, endUs: 1000000 },
          markersUs: [],
        },
      ],
    },
    ranges: [{ startUs: 0, endUs: 1000000 }],
    names: ["test.mp4"],
  });
}
async function enqueue() {
  return engine.asRole("axfluxo_video_api").transaction(async (sql) => {
    await requireMembership(sql, owner);
    return createBatch(sql, owner, snapshot, 1);
  });
}
async function nowClaim() {
  const c = await claim(worker(), () => 0);
  expect(c).not.toBeNull();
  return c!;
}
async function expire() {
  await engine.query(
    "UPDATE axfluxo_video.render_slot SET lease_until=clock_timestamp()-interval '1 second' WHERE id=1",
  );
}
async function due(job: string) {
  await engine.query(
    "UPDATE axfluxo_video.render_executions SET next_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
    [job],
  );
}
const limits = () => ({
  directory: dir,
  maxWorkBytes: 1024 ** 3,
  minFreeBytes: 64 * 1024 ** 2,
  segmentFrames: 30,
});
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "axfluxo-render-test-"));
  engine = testEngine(join(dir, "db"));
  for (const name of [
    "001_video_foundation.sql",
    "002_cloud_library.sql",
    "003_video_preview.sql",
    "004_video_render.sql",
  ])
    await engine.exec(
      await readFile(
        new URL(`../../db/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
}, 30000);
afterAll(async () => {
  await engine?.close();
});
beforeEach(async () => {
  // Retain every row/object. Finish any prior active test job rather than deleting DB/data.
  await engine.query(
    "UPDATE axfluxo_video.render_jobs SET state='failed' WHERE state IN ('queued','running','cancel_requested')",
  );
  await engine.query(
    "UPDATE axfluxo_video.render_slot SET owner_id=NULL,job_id=NULL,lease_until=NULL WHERE id=1",
  );
  await seed();
});
it("DB queue duplicate delivery has one claim; expiry fences a late worker; retry has a new token", async () => {
  await enqueue();
  const results = await Promise.all([claim(worker()), claim(worker())]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const a = results.find(Boolean)!;
  await heartbeat(worker(), a);
  await expire();
  expect(await claim(worker(), () => 0)).toBeNull();
  expect(
    (
      await engine.query(
        "SELECT state FROM axfluxo_video.render_jobs WHERE id=$1",
        [a.job],
      )
    ).rows[0].state,
  ).toBe("held");
  await engine.query(
    "UPDATE axfluxo_video.render_jobs SET state='queued' WHERE id=$1",
    [a.job],
  );
  await due(a.job);
  const b = await nowClaim();
  expect(BigInt(b.token)).toBeGreaterThan(BigInt(a.token));
  expect(b.runs).toBe(2);
  await expect(fenced(worker(), a, async () => true)).rejects.toThrow(
    "LEASE_LOST",
  );
  await expect(
    publish(worker(), a, { id: randomUUID() }, {}, 60),
  ).rejects.toThrow("LEASE_LOST");
  expect(await finishFailure(worker(), a, "STORAGE_TRANSIENT")).toBe(false);
  await finishFailure(worker(), b, "INPUT_CORRUPT");
});
it("initial plus two transient attempts only; permanent faults never retry", async () => {
  await enqueue();
  const first = await nowClaim();
  await finishFailure(worker(), first, "STORAGE_TRANSIENT", () => 0);
  const e = (
    await engine.query(
      "SELECT EXTRACT(EPOCH FROM(next_at-clock_timestamp())) AS delay FROM axfluxo_video.render_executions WHERE job_id=$1",
      [first.job],
    )
  ).rows[0];
  expect(Number(e.delay)).toBeGreaterThan(25);
  await due(first.job);
  const second = await nowClaim();
  await finishFailure(worker(), second, "PROCESS_TIMEOUT", () => 0);
  await due(first.job);
  const third = await nowClaim();
  await finishFailure(worker(), third, "STORAGE_TRANSIENT");
  expect(await claim(worker())).toBeNull();
  expect(
    (
      await engine.query(
        "SELECT state FROM axfluxo_video.render_jobs WHERE id=$1",
        [first.job],
      )
    ).rows[0].state,
  ).toBe("failed");
  expect(
    (
      await engine.query(
        "SELECT state FROM axfluxo_video.usage_reservations WHERE job_id=$1",
        [first.job],
      )
    ).rows[0].state,
  ).toBe("consumed");
});
it.each([
  "DISK_FULL",
  "OUT_OF_MEMORY",
  "RESOURCE_LIMIT",
  "QUOTA_EXCEEDED",
] as const)(
  "holds %s without repeated attempts or freeing pins",
  async (code) => {
    await enqueue();
    const c = await nowClaim();
    await finishFailure(worker(), c, code);
    expect(await claim(worker())).toBeNull();
    expect(
      (
        await engine.query(
          "SELECT state FROM axfluxo_video.render_jobs WHERE id=$1",
          [c.job],
        )
      ).rows[0].state,
    ).toBe("held");
    expect(
      (
        await engine.query(
          "SELECT state FROM axfluxo_video.usage_reservations WHERE job_id=$1",
          [c.job],
        )
      ).rows[0].state,
    ).toBe("reserved");
    expect(
      (
        await engine.query(
          "SELECT * FROM axfluxo_video.resource_pins WHERE job_id=$1",
          [c.job],
        )
      ).rows,
    ).toHaveLength(1);
  },
);
it("revocation/cancellation abort live execution and prohibit output publication", async () => {
  await enqueue();
  const c = await nowClaim();
  await engine.query(
    "UPDATE axfluxo_video.developer_memberships SET active=false WHERE owner_id=$1",
    [owner],
  );
  await expect(heartbeat(worker(), c)).rejects.toThrow("DEVELOPER_REVOKED");
  await finishFailure(worker(), c, "DEVELOPER_REVOKED");
  expect(
    (
      await engine.query(
        "SELECT state FROM axfluxo_video.render_jobs WHERE id=$1",
        [c.job],
      )
    ).rows[0].state,
  ).toBe("held");
  await engine.query(
    "UPDATE axfluxo_video.developer_memberships SET active=true WHERE owner_id=$1",
    [owner],
  );
  await enqueue();
  const d = await nowClaim();
  await engine.query(
    "UPDATE axfluxo_video.render_jobs SET state='cancel_requested' WHERE id=$1",
    [d.job],
  );
  await expect(heartbeat(worker(), d)).rejects.toThrow("CANCELLED");
  await finishFailure(worker(), d, "CANCELLED");
  expect(
    (
      await engine.query(
        "SELECT state FROM axfluxo_video.render_jobs WHERE id=$1",
        [d.job],
      )
    ).rows[0].state,
  ).toBe("cancelled");
});
it("renders, validates, survives upload failure and reuses hash-verified video checkpoints; one output and unchanged original", async () => {
  await enqueue();
  const c = await nowClaim();
  const original = await fileHash(source);
  storage.failOutput = true;
  expect(await executeRender(worker(), storage, c, limits())).toMatchObject({
    state: "stopped",
    code: "STORAGE_TRANSIENT",
  });
  const segments = (
    await engine.query(
      "SELECT * FROM axfluxo_video.render_objects WHERE job_id=$1 AND kind='segment' AND ready",
      [c.job],
    )
  ).rows;
  expect(segments).toHaveLength(2);
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.render_outputs WHERE job_id=$1",
        [c.job],
      )
    ).rows,
  ).toHaveLength(0);
  storage.failOutput = false;
  storage.lose = true;
  await due(c.job);
  const d = await nowClaim();
  const result = await executeRender(worker(), storage, d, limits());
  expect(result.state).toBe("succeeded");
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.render_objects WHERE job_id=$1 AND kind='segment'",
        [c.job],
      )
    ).rows,
  ).toHaveLength(2);
  const outputs = (
    await engine.query(
      "SELECT * FROM axfluxo_video.render_outputs WHERE job_id=$1",
      [c.job],
    )
  ).rows;
  expect(outputs).toHaveLength(1);
  expect(Number(outputs[0].frame_count)).toBe(60);
  const router = renderRouter({
    db: engine.asRole("axfluxo_video_api"),
    storage,
    enabled: () => true,
    unitsPerFrame: 1,
  });
  const accessRequest = new Request(
    `https://api.test/render-outputs/${outputs[0].id}/access`,
  );
  expect((await router(accessRequest, owner)).status).toBe(200);
  const outsider = randomUUID();
  await engine.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true)",
    [outsider],
  );
  await expect(router(accessRequest, outsider)).rejects.toMatchObject({
    status: 404,
  });
  expect(await claim(worker())).toBeNull();
  await expect(
    publish(worker(), c, { id: randomUUID() }, {}, 60),
  ).rejects.toThrow("LEASE_LOST");
  expect(await fileHash(source)).toBe(original);
  expect(
    createHash("sha256")
      .update(storage.objects.get(`originals/${owner}/source`)!)
      .digest("hex"),
  ).toBe(original);
  await expect(
    engine.query(
      "UPDATE axfluxo_video.media_versions SET hash=$2 WHERE owner_id=$1",
      [owner, "0".repeat(64)],
    ),
  ).rejects.toThrow("immutable");
}, 120000);
it("rejects corrupted input before rendering and disk budget exhaustion holds", async () => {
  await enqueue();
  let c = await nowClaim();
  storage.objects.set(`originals/${owner}/source`, new Uint8Array([0]));
  expect(await executeRender(worker(), storage, c, limits())).toMatchObject({
    code: "INPUT_CORRUPT",
  });
  await enqueue();
  c = await nowClaim();
  expect(
    await executeRender(worker(), storage, c, { ...limits(), maxWorkBytes: 1 }),
  ).toMatchObject({ code: "DISK_FULL" });
});
it("frame-boundary segments have no audio; final AAC is encoded once with one priming packet", async () => {
  const input: Input = { path: source, info: await probe(source) },
    plan = renderPlan(snapshot, 0, "all-versions", 30);
  plan.width = 320;
  plan.height = 180;
  const stage = await mkdtemp(join(dir, "encode-")),
    paths = [];
  for (const s of plan.segments) {
    const path = join(stage, `s${s.index}.mp4`);
    await encodeSegment(input, s, plan, path);
    await validateVideo(path, { ...plan, frames: s.frames });
    paths.push(path);
  }
  const result = await assemble(plan, [input], paths, stage);
  expect(result.audioMode).toBe("encoded");
  const v = await validateVideo(result.path, { ...plan, audio: true });
  expect(v.frames).toBe(60);
  expect(v.audioSamples).toBeGreaterThanOrEqual(48000);
  const broken = join(stage, "broken.mp4");
  await writeFile(broken, (await readFile(result.path)).subarray(0, 300));
  await expect(
    validateVideo(broken, { ...plan, audio: true }),
  ).rejects.toThrow();
}, 30000);
it("only exact full-source compatible AAC can copy; partial cuts encode", async () => {
  const path = await make(`aac-copy-${owner}.mp4`, ["-t", "1.001"]);
  const info = await probe(path),
    s = structuredClone(snapshot);
  s.document.clips[0].sourceDurationUs = Math.round(
    Number(info.format.duration) * 1e6,
  );
  s.document.clips[0].interval.endUs = s.document.clips[0].sourceDurationUs;
  s.ranges[0].endUs = s.document.clips[0].sourceDurationUs;
  const plan = renderPlan(s, 0),
    input = { path, info };
  expect(canCopyAudio(plan, [input])).toBe(false); // VFR duration is not an exact output-frame/sample boundary.
  plan.pieces[0].sourceStartUs = 16667;
  expect(canCopyAudio(plan, [input])).toBe(false);
});
it("render APIs enforce auth, owner and revoked membership and idempotent All Versions admission", async () => {
  const api = () =>
    createVideoApi({
      db: engine.asRole("axfluxo_video_api"),
      verify: async (auth) => {
        if (!auth) throw new ApiError(401, "UNAUTHENTICATED");
        return { ownerId: auth };
      },
      allowedOrigins: ["https://editor.test"],
      admissionEnabled: () => true,
      unitsPerFrame: 1,
      render: renderRouter({
        db: engine.asRole("axfluxo_video_api"),
        storage,
        enabled: () => true,
        unitsPerFrame: 1,
      }),
    });
  const request = (path: string, auth: string | null = owner, body?: unknown) =>
    api()(
      new Request(`https://api.test${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          ...(auth ? { authorization: auth } : {}),
          "content-type": "application/json",
          "idempotency-key": "render-test-key",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  expect(
    (
      await request("/render-all-versions", null, {
        document: snapshot.document,
      })
    ).status,
  ).toBe(401);
  const a = await request("/render-all-versions", owner, {
    document: snapshot.document,
  });
  expect(a.status).toBe(202);
  const batch = await a.json();
  expect(
    await (
      await request("/render-all-versions", owner, {
        document: snapshot.document,
      })
    ).json(),
  ).toEqual(batch);
  expect(
    (
      await request("/render-all-versions", owner, {
        document: { ...snapshot.document, revision: 1 },
      })
    ).status,
  ).toBe(409);
  const job = batch.jobs[0].id;
  expect((await request(`/render-jobs/${job}/progress`)).status).toBe(200);
  const other = randomUUID();
  await engine.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true)",
    [other],
  );
  expect((await request(`/render-jobs/${job}/progress`, other)).status).toBe(
    404,
  );
  await engine.query(
    "UPDATE axfluxo_video.developer_memberships SET active=false WHERE owner_id=$1",
    [owner],
  );
  expect((await request(`/render-jobs/${job}/progress`)).status).toBe(403);
});

it("actual process kill leaves no output and native DB lease recovery fences the dead claimant", async () => {
  await enqueue();
  if (process.env.AXFLUXO_TEST_POSTGRES_URL) {
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        new URL("./claim-child.ts", import.meta.url).pathname,
      ],
      { stdio: ["ignore", "pipe", "ignore"], env: process.env },
    );
    const line = await new Promise<string>((resolve, reject) => {
      let s = "";
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("claim child timeout"));
      }, 15000);
      child.stdout.on("data", (b) => {
        s += b;
        if (s.includes("\n")) {
          clearTimeout(t);
          resolve(s.trim());
        }
      });
      child.on("error", reject);
    });
    const dead = JSON.parse(line);
    expect(dead?.job).toBeTruthy();
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    child.kill("SIGKILL");
    await closed;
    expect(
      (
        await engine.query(
          "SELECT * FROM axfluxo_video.render_outputs WHERE job_id=$1",
          [dead.job],
        )
      ).rows,
    ).toHaveLength(0);
    await expire();
    await claim(worker(), () => 0);
    await engine.query(
      "UPDATE axfluxo_video.render_jobs SET state='queued' WHERE id=$1",
      [dead.job],
    );
    await due(dead.job);
    const recovered = await nowClaim();
    expect(BigInt(recovered.token)).toBeGreaterThan(BigInt(dead.token));
    await finishFailure(worker(), recovered, "INPUT_CORRUPT");
  } else {
    // Embedded DB has one backend and cannot be opened by two processes. Exercise fencing here;
    // the very same case runs a SIGKILL claimant against native PostgreSQL.
    const c = await nowClaim();
    await expire();
    await claim(worker(), () => 0);
    await engine.query(
      "UPDATE axfluxo_video.render_jobs SET state='queued' WHERE id=$1",
      [c.job],
    );
    await due(c.job);
    const d = await nowClaim();
    await expect(heartbeat(worker(), c)).rejects.toThrow("LEASE_LOST");
    await finishFailure(worker(), d, "INPUT_CORRUPT");
  }
}, 30000);

it("remote corrupted checkpoint is rejected, not silently regenerated or published", async () => {
  await enqueue();
  const c = await nowClaim();
  storage.failOutput = true;
  await executeRender(worker(), storage, c, limits());
  const row = (
    await engine.query(
      "SELECT object_key FROM axfluxo_video.render_objects WHERE job_id=$1 AND kind='segment' AND ready LIMIT 1",
      [c.job],
    )
  ).rows[0];
  expect(row).toBeTruthy();
  storage.objects.set(String(row.object_key), new Uint8Array([1, 2, 3]));
  await due(c.job);
  const d = await nowClaim();
  expect(await executeRender(worker(), storage, d, limits())).toMatchObject({
    code: "CHECKPOINT_CORRUPT",
  });
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.render_outputs WHERE job_id=$1",
        [c.job],
      )
    ).rows,
  ).toHaveLength(0);
}, 60000);

it("a publication transaction failure rolls back output, catalogue and accounting together", async () => {
  await enqueue();
  const c = await nowClaim();
  const { storeObject } = await import("../../worker/render/objects");
  const object = await storeObject(worker(), storage, c, {
    path: source,
    hash: await fileHash(source),
    size: (await stat(source)).size,
    kind: "output",
    planHash: "a".repeat(64),
  });
  const broken = {
    transaction: <T>(
      work: (sql: import("../../db/database").Sql) => Promise<T>,
    ) =>
      worker().transaction((sql) =>
        work({
          query: (text, values) => {
            if (text.includes("INSERT INTO axfluxo_video.render_artifacts"))
              throw new Error("injected private DB failure");
            return sql.query(text, values);
          },
        }),
      ),
  };
  await expect(publish(broken, c, object, {}, 60)).rejects.toThrow("injected");
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.render_outputs WHERE job_id=$1",
        [c.job],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await engine.query(
        "SELECT state FROM axfluxo_video.usage_reservations WHERE job_id=$1",
        [c.job],
      )
    ).rows[0].state,
  ).toBe("reserved");
  const id = await publish(worker(), c, object, {}, 60);
  expect(id).toBeTruthy();
  await expect(publish(worker(), c, object, {}, 60)).rejects.toThrow(
    "LEASE_LOST",
  );
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.render_outputs WHERE job_id=$1",
        [c.job],
      )
    ).rows,
  ).toHaveLength(1);
});

it("30-second audio stays continuous through many video checkpoints with no boundary priming", async () => {
  const inputPath = await make(`long-${owner}.mp4`, ["-r", "60"], 30),
    info = await probe(inputPath),
    s = structuredClone(snapshot);
  s.document.clips[0].sourceDurationUs = 30_000_000;
  s.document.clips[0].interval.endUs = 30_000_000;
  s.ranges[0].endUs = 30_000_000;
  const plan = renderPlan(s, 0, "all-versions", 300);
  plan.width = 160;
  plan.height = 90;
  const stage = await mkdtemp(join(dir, "long-")),
    paths = [];
  for (const seg of plan.segments) {
    const p = join(stage, `s${seg.index}.mp4`);
    await encodeSegment({ path: inputPath, info }, seg, plan, p);
    paths.push(p);
  }
  const result = await assemble(
      plan,
      [{ path: inputPath, info }],
      paths,
      stage,
    ),
    validation = await validateVideo(result.path, { ...plan, audio: true });
  expect(validation.frames).toBe(1800);
  function pcm(path: string) {
    return execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        path,
        "-map",
        "0:a:0",
        "-f",
        "s16le",
        "-ac",
        "1",
        "-ar",
        "48000",
        "pipe:1",
      ],
      { maxBuffer: 4 * 1024 ** 2 },
    );
  }
  const original = pcm(inputPath),
    out = pcm(result.path);
  for (const t of [0.1, 4.99, 5.01, 9.99, 10.01, 24.99, 25.01, 29.8]) {
    const start = Math.round(t * 48000);
    let dot = 0,
      aa = 0,
      bb = 0;
    for (let n = start; n < start + 2048; n++) {
      const a = original.readInt16LE(n * 2),
        b = out.readInt16LE(n * 2);
      dot += a * b;
      aa += a * a;
      bb += b * b;
    }
    expect(dot / Math.sqrt(aa * bb)).toBeGreaterThan(0.98);
  }
}, 120000);

it("copies exact full-source AAC packets only; All Versions always encodes once", async () => {
  const path = await make(`copy-exact-${owner}.mp4`, ["-r", "60", "-t", "1"]);
  const info = await probe(path),
    s = structuredClone(snapshot);
  s.document.clips[0].sourceDurationUs = 1_000_000;
  const input = { path, info },
    plan = renderPlan(s, 0, "fnf", 60);
  plan.width = 160;
  plan.height = 90;
  expect(canCopyAudio(plan, [input])).toBe(true);
  const stage = await mkdtemp(join(dir, "copy-")),
    segment = join(stage, "s.mp4");
  await encodeSegment(input, plan.segments[0], plan, segment);
  const result = await assemble(plan, [input], [segment], stage);
  expect(result.audioMode).toBe("copy");
  await validateVideo(result.path, { ...plan, audio: true });
  const hashes = (p: string) =>
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_packets",
        "-show_data_hash",
        "sha256",
        "-show_entries",
        "packet=data_hash",
        "-of",
        "csv=p=0",
        p,
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((s) => s.startsWith("SHA256:"))
      .map((s) => s.split(",")[0]);
  expect(hashes(result.path)).toEqual(hashes(path));
  expect(hashes(path).length).toBeGreaterThan(1);
  expect(canCopyAudio({ ...plan, mode: "all-versions" }, [input])).toBe(false);
}, 30000);

it.each(["30000/1001", "30", "60000/1001", "60"])(
  "renders %s input on exact 60fps CFR frame boundaries",
  async (rate) => {
    const path = join(dir, `rate-${rate.replace("/", "-")}-${owner}.mp4`);
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=160x90:rate=${rate}:duration=1`,
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-y",
        path,
      ],
      { stdio: "ignore" },
    );
    const s = structuredClone(snapshot),
      info = await probe(path);
    s.document.clips[0].sourceDurationUs = Math.round(
      Number(info.format.duration) * 1e6,
    );
    const plan = renderPlan(s, 0);
    plan.width = 160;
    plan.height = 90;
    const output = join(dir, `cfr-${owner}.mp4`);
    await encodeSegment({ path, info }, plan.segments[0], plan, output);
    expect((await validateVideo(output, plan)).frames).toBe(60);
  },
);

it.each(["smpte2084", "arib-std-b67"])(
  "converts real %s BT.2020 HDR into decoded BT.709 SDR",
  async (transfer) => {
    const path = join(dir, `hdr-${owner}.mp4`);
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=60:duration=1",
        "-vf",
        "format=yuv420p10le",
        "-c:v",
        "libx265",
        "-x265-params",
        "pools=1:frame-threads=1:log-level=error",
        "-color_primaries",
        "bt2020",
        "-colorspace",
        "bt2020nc",
        "-color_trc",
        transfer,
        "-y",
        path,
      ],
      { stdio: "ignore" },
    );
    const info = await probe(path),
      plan = renderPlan(snapshot, 0);
    plan.width = 160;
    plan.height = 90;
    const output = join(dir, `sdr-${owner}.mp4`);
    await encodeSegment({ path, info }, plan.segments[0], plan, output);
    await validateVideo(output, plan);
    expect((await probe(output)).streams[0]).toMatchObject({
      color_primaries: "bt709",
      color_transfer: "bt709",
      color_space: "bt709",
      pix_fmt: "yuv420p",
    });
  },
  30000,
);

it("normalizes genuine rotation matrix, non-square SAR and variable input PTS", async () => {
  const path = await make(`vfr-sar-${owner}.mp4`, [
    "-vf",
    "setsar=2/1,select='not(mod(n,3))',setpts=PTS",
    "-fps_mode",
    "vfr",
  ]);
  const bytes = await readFile(path);
  function patch(start: number, end: number): boolean {
    for (let pos = start; pos + 8 <= end;) {
      const size = bytes.readUInt32BE(pos),
        type = bytes.toString("ascii", pos + 4, pos + 8);
      if (size < 8 || pos + size > end) break;
      if (type === "tkhd") {
        const p = pos + 8 + (bytes[pos + 8] === 1 ? 52 : 40);
        [0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824].forEach((v, i) =>
          bytes.writeInt32BE(v, p + i * 4),
        );
        return true;
      }
      if (["moov", "trak"].includes(type) && patch(pos + 8, pos + size))
        return true;
      pos += size;
    }
    return false;
  }
  expect(patch(0, bytes.length)).toBe(true);
  await writeFile(path, bytes);
  const info = await probe(path);
  expect(
    Math.abs(
      info.streams[0].side_data_list!.find((s) => s.rotation !== undefined)!
        .rotation!,
    ),
  ).toBe(90);
  const plan = renderPlan(snapshot, 0);
  plan.width = 160;
  plan.height = 90;
  const output = join(dir, `rotated-output-${owner}.mp4`);
  await encodeSegment({ path, info }, plan.segments[0], plan, output);
  await validateVideo(output, plan);
  expect((await probe(output)).streams[0].sample_aspect_ratio).toBe("1:1");
}, 30000);

it("real output quota exhaustion holds before uploading and retains the original", async () => {
  await enqueue();
  const c = await nowClaim();
  await engine.query(
    "UPDATE axfluxo_video.media_quotas SET limit_bytes=1 WHERE owner_id=$1",
    [owner],
  );
  expect(await executeRender(worker(), storage, c, limits())).toMatchObject({
    code: "QUOTA_EXCEEDED",
  });
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.render_outputs WHERE job_id=$1",
        [c.job],
      )
    ).rows,
  ).toHaveLength(0);
  expect(storage.objects.has(`originals/${owner}/source`)).toBe(true);
}, 30000);
