import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { testEngine, type TestEngine } from "../engine";
import { FakeStorage } from "../cloud/fake-storage";
import { createVideoApi } from "../../api/app";
import { fnfRouter } from "../../api/preferences/router";
import { renderRouter } from "../../api/render";
import { ApiError } from "../../api/errors";
import { FnfSession } from "../../../src/services/video/fnf-session";
import {
  defaultFnfPreferences,
  fnfPreferencesSchema,
  fnfShowcaseSnapshotSchema,
} from "../../../src/domain/video/fnf-showcase";
import { claim, finishFailure } from "../../worker/jobs/queue";
import { executeRender } from "../../worker/render/service";
import { fileHash, probe } from "../../worker/render/process";
import { probeMedia } from "../../worker/probe/media";
import {
  fnfOverlay,
  gameplayGeometry,
  sourceGeometry,
} from "../../worker/templates/fnf-showcase/render";
let engine: TestEngine,
  dir: string,
  owner: string,
  session: FnfSession,
  source: string,
  storage: Storage;
let enabled = true;
class Storage extends FakeStorage {
  names = new Map<string, string>();
  async putRender(key: string, path: string) {
    if (this.objects.has(key)) throw new Error("immutable");
    this.objects.set(key, await readFile(path));
  }
  async access(key: string, _mime?: string, name?: string) {
    this.names.set(key, name ?? "");
    return super.access(key);
  }
}
const worker = () => engine.asRole("axfluxo_video_render");
const api = () =>
  createVideoApi({
    db: engine.asRole("axfluxo_video_api"),
    verify: async (auth) => {
      if (!auth) throw new ApiError(401, "UNAUTHENTICATED");
      return { ownerId: auth };
    },
    allowedOrigins: ["https://editor.test"],
    admissionEnabled: () => enabled,
    unitsPerFrame: 1,
    fnf: fnfRouter({
      db: engine.asRole("axfluxo_video_api"),
      enabled: () => enabled,
      unitsPerFrame: 1,
    }),
    render: renderRouter({
      db: engine.asRole("axfluxo_video_api"),
      storage,
      enabled: () => enabled,
      unitsPerFrame: 1,
    }),
  });
const request = (
  path: string,
  body?: unknown,
  auth: string | null = owner,
  key = randomUUID(),
  revision = 0,
) =>
  api()(
    new Request(`https://api.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(auth ? { authorization: auth } : {}),
        "content-type": "application/json",
        "idempotency-key": key,
        "if-match": `"${revision}"`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
function prefs() {
  const p = defaultFnfPreferences();
  p.username = "@日本語_user";
  p.template = {
    ...p.template,
    presetWidth: 160,
    presetHeight: 90,
    scale: 1080 / 160,
  };
  return p;
}
async function sourceFile(path: string, vfr = false) {
  execFileSync(
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
      "sine=frequency=440:sample_rate=48000:duration=1",
      "-vf",
      "drawbox=color=red:t=fill:enable='lt(t,0.5)',drawbox=color=blue:t=fill:enable='gte(t,0.5)'" +
        (vfr ? ",select='not(mod(n,3))',setpts=PTS" : ""),
      ...(vfr ? ["-fps_mode", "vfr"] : []),
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-y",
      path,
    ],
    { stdio: "ignore" },
  );
}
async function register(path: string) {
  const hash = await fileHash(path),
    asset = randomUUID(),
    version = randomUUID(),
    key = `originals/${owner}/${version}`,
    metadata = await probeMedia(path, (await stat(path)).size, "video/mp4");
  storage.objects.set(key, await readFile(path));
  await engine.query(
    "INSERT INTO axfluxo_video.media_assets(id,owner_id,name) VALUES($1,$2,'gameplay')",
    [asset, owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.media_versions(id,owner_id,asset_id,object_key,hash,size,mime,kind,probe) VALUES($1,$2,$3,$4,$5,$6,'video/mp4','video',$7::jsonb)",
    [
      version,
      owner,
      asset,
      key,
      hash,
      (await stat(path)).size,
      JSON.stringify(metadata),
    ],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.resource_versions(owner_id,library_id,file_id,version_id,hash,kind) VALUES($1,'cloud',$2,$3,$4,'video')",
    [owner, asset, version, hash],
  );
  return {
    reference: {
      libraryId: "cloud",
      fileId: asset,
      versionId: version,
      hash,
      kind: "video" as const,
    },
    durationUs: metadata.durationUs!,
    width: metadata.displayWidth!,
    height: metadata.displayHeight!,
    geometryVerified: true,
  };
}
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "axfluxo-v6-"));
  engine = testEngine(join(dir, "db"));
  for (const name of [
    "001_video_foundation.sql",
    "002_cloud_library.sql",
    "003_video_preview.sql",
    "004_video_render.sql",
    "005_all_versions_projects.sql",
    "006_fnf_preferences.sql",
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
  vi.unstubAllEnvs();
  enabled = true;
  owner = randomUUID();
  storage = new Storage();
  await engine.query(
    "UPDATE axfluxo_video.render_jobs SET state='failed' WHERE state IN ('queued','running')",
  );
  await engine.query(
    "UPDATE axfluxo_video.render_slot SET owner_id=NULL,job_id=NULL,lease_until=NULL WHERE id=1",
  );
  await engine.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true)",
    [owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.usage_budgets(owner_id,limit_units) VALUES($1,1000000)",
    [owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.media_quotas(owner_id,limit_bytes) VALUES($1,1000000000)",
    [owner],
  );
  source = join(dir, `${owner}.mp4`);
  await sourceFile(source);
  session = new FnfSession(await register(source));
});
it("preferences admit only template/username; owner, membership, revision and unknown keys fail closed", async () => {
  const p = prefs();
  expect((await request("/preferences/fnf-showcase", p, null)).status).toBe(
    401,
  );
  expect(
    (
      await request("/preferences/fnf-showcase", {
        ...p,
        ranges: [{ name: "NEVER_SAVE" }],
      })
    ).status,
  ).toBe(400);
  expect((await request("/preferences/fnf-showcase", p)).status).toBe(200);
  expect((await request("/preferences/fnf-showcase", p)).status).toBe(409);
  const stored = (
    await engine.query(
      "SELECT preferences FROM axfluxo_video.developer_preferences WHERE owner_id=$1",
      [owner],
    )
  ).rows[0].preferences;
  expect(stored).toEqual(p);
  expect(fnfPreferencesSchema.safeParse(stored).success).toBe(true);
  expect(JSON.stringify(stored)).not.toContain("ranges");
  const other = randomUUID();
  await engine.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true)",
    [other],
  );
  expect(
    (
      await (
        await request("/preferences/fnf-showcase", undefined, other)
      ).json()
    ).revision,
  ).toBe(0);
  expect(
    (
      await request(
        `/fnf-showcase/source/${session.source.reference.versionId}`,
        undefined,
        other,
      )
    ).status,
  ).toBe(404);
  await engine.query(
    "UPDATE axfluxo_video.developer_memberships SET active=false WHERE owner_id=$1",
    [owner],
  );
  expect((await request("/preferences/fnf-showcase")).status).toBe(403);
});
it("one batch atomically accepts overlapping stable-order ranges with safe unique names and idempotency", async () => {
  session.name(session.ranges[0].id, "日本語");
  const a = session.addAt(0);
  session.edit(a.id, 0, 500000);
  session.name(a.id, "日本語");
  const b = session.addAt(500000);
  session.name(b.id, "../bad:name");
  const snapshot = session.snapshot(prefs()),
    key = randomUUID();
  const [first, second] = await Promise.all([
    request("/fnf-showcase/batches", snapshot, owner, key),
    request("/fnf-showcase/batches", snapshot, owner, key),
  ]);
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual(await second.json());
  expect(
    (
      await request(
        "/fnf-showcase/batches",
        { ...snapshot, id: randomUUID() },
        owner,
        key,
      )
    ).status,
  ).toBe(409);
  const jobs = (
    await engine.query(
      "SELECT * FROM axfluxo_video.render_jobs WHERE owner_id=$1 ORDER BY range_index",
      [owner],
    )
  ).rows;
  expect(jobs.map((j) => Number(j.range_index))).toEqual([0, 1, 2]);
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.outbox_events WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(3);
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.usage_reservations WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(3);
  expect(
    fnfShowcaseSnapshotSchema.parse(
      (
        await engine.query(
          "SELECT snapshot FROM axfluxo_video.render_batches WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].snapshot,
    ).chartNames,
  ).toEqual(["日本語", "日本語", "../bad:name"]);
});
it("success outputs are not recreated when retrying the failed range; audio copy/fallback, order and filename remain correct", async () => {
  session.name(session.ranges[0].id, "日本語");
  const second = session.addAt(0);
  session.edit(second.id, 0, 500000);
  session.name(second.id, "日本語");
  const third = session.addAt(500000);
  session.name(third.id, "../bad:name");
  const snapshot = session.snapshot(prefs()),
    response = await request("/fnf-showcase/batches", snapshot);
  expect(response.status).toBe(202);
  const accepted = await response.json(),
    originalHash = await fileHash(source);
  const a = await claim(worker());
  expect(a?.rangeIndex).toBe(0);
  expect(
    await executeRender(worker(), storage, a!, {
      directory: dir,
      maxWorkBytes: 1024 ** 3,
      minFreeBytes: 64 * 1024 ** 2,
      segmentFrames: 30,
    }),
  ).toMatchObject({ state: "succeeded" });
  const b = await claim(worker());
  expect(b?.rangeIndex).toBe(1);
  await finishFailure(worker(), b!, "INPUT_CORRUPT");
  const c = await claim(worker());
  expect(c?.rangeIndex).toBe(2);
  expect(
    await executeRender(worker(), storage, c!, {
      directory: dir,
      maxWorkBytes: 1024 ** 3,
      minFreeBytes: 64 * 1024 ** 2,
      segmentFrames: 30,
    }),
  ).toMatchObject({ state: "succeeded" });
  const before = (
    await engine.query(
      "SELECT id,job_id,hash FROM axfluxo_video.render_outputs WHERE owner_id=$1 ORDER BY job_id",
      [owner],
    )
  ).rows;
  expect(before).toHaveLength(2);
  expect((await request(`/render-jobs/${a!.job}/retry`, {})).status).toBe(409);
  expect((await request(`/render-jobs/${b!.job}/retry`, {})).status).toBe(202);
  const retry = await claim(worker());
  expect(retry?.rangeIndex).toBe(1);
  expect(
    await executeRender(worker(), storage, retry!, {
      directory: dir,
      maxWorkBytes: 1024 ** 3,
      minFreeBytes: 64 * 1024 ** 2,
    }),
  ).toMatchObject({ state: "succeeded" });
  const view = await (
    await request(`/fnf-showcase/batches/${accepted.id}`)
  ).json();
  expect(view.items.map((i: { filename: string }) => i.filename)).toEqual(
    snapshot.names,
  );
  expect(view.batch.outputs).toHaveLength(3);
  expect(await fileHash(source)).toBe(originalHash);
  for (const old of before)
    expect(
      (
        await engine.query(
          "SELECT id,job_id,hash FROM axfluxo_video.render_outputs WHERE id=$1",
          [old.id],
        )
      ).rows[0],
    ).toEqual(old);
  const rows = (
    await engine.query(
      "SELECT r.job_id,r.frame_count,a.validation,o.object_key FROM axfluxo_video.render_outputs r JOIN axfluxo_video.render_artifacts a ON a.output_id=r.id JOIN axfluxo_video.render_objects o ON o.id=a.object_id WHERE r.owner_id=$1",
      [owner],
    )
  ).rows;
  expect(rows.find((r) => r.job_id === a!.job)!.validation).toMatchObject({
    audioMode: "copy",
    frames: 60,
  });
  expect(rows.find((r) => r.job_id === retry!.job)!.validation).toMatchObject({
    audioMode: "encoded",
    frames: 30,
  });
  for (const output of view.batch.outputs) {
    expect((await request(`/render-outputs/${output.id}/access`)).status).toBe(
      200,
    );
    const row = rows.find((r) => r.job_id === output.jobId)!;
    const range = view.batch.jobs.find(
      (j: { id: string }) => j.id === output.jobId,
    ).rangeIndex;
    expect(storage.names.get(String(row.object_key))).toBe(
      snapshot.names[range],
    );
  }
  for (const output of view.batch.outputs) {
    const row = rows.find((r) => r.job_id === output.jobId)!;
    const index = view.batch.jobs.find(
      (j: { id: string }) => j.id === output.jobId,
    ).rangeIndex;
    const path = join(dir, `range-${owner}-${index}.mp4`);
    await writeFile(path, storage.objects.get(String(row.object_key))!);
    const rgb = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      "crop=16:16:532:952",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    let red = 0,
      blue = 0;
    for (let i = 0; i < rgb.length; i += 3) {
      red += rgb[i];
      blue += rgb[i + 2];
    }
    if (index === 2) expect(blue).toBeGreaterThan(red * 2);
    else expect(red).toBeGreaterThan(blue * 2);
  }
  const full = rows.find((r) => r.job_id === a!.job)!;
  const path = join(dir, "published-" + owner + ".mp4");
  await writeFile(path, storage.objects.get(String(full.object_key))!);
  const info = await probe(path);
  expect(info.streams[0]).toMatchObject({
    width: 1080,
    height: 1920,
    codec_name: "h264",
    avg_frame_rate: "60/1",
  });
  const frames = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      "select='eq(n,0)+eq(n,30)+eq(n,59)',crop=1000:220:40:130",
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: 3 * 1024 ** 2 },
  );
  const n = 1000 * 220 * 3;
  expect(frames.length).toBe(n * 3);
  let bright = 0,
    delta = 0;
  for (let i = 0; i < n; i++) {
    bright += frames[i];
    delta +=
      Math.abs(frames[i] - frames[n + i]) +
      Math.abs(frames[i] - frames[2 * n + i]);
  }
  expect(bright / n).toBeGreaterThan(3);
  expect(delta / n).toBeLessThan(1);
  const other = randomUUID();
  await engine.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true)",
    [other],
  );
  expect(
    (await request(`/fnf-showcase/batches/${accepted.id}`, undefined, other))
      .status,
  ).toBe(404);
}, 180000);
it("geometry warns instead of adapting a fixed preset, rejects destructive crop and respects black centered layout", () => {
  const p = prefs();
  expect(gameplayGeometry(p, { width: 160, height: 90 })).toMatchObject({
    width: 1080,
    presetMismatch: false,
  });
  expect(
    gameplayGeometry(defaultFnfPreferences(), { width: 1280, height: 720 })
      .presetMismatch,
  ).toBe(true);
  p.template.cropTop = 45;
  p.template.cropBottom = 45;
  expect(() => gameplayGeometry(p, { width: 160, height: 90 })).toThrow(
    "FNF_INVALID_CROP",
  );
  expect(
    sourceGeometry({
      width: 1920,
      height: 1080,
      sample_aspect_ratio: "1:1",
      side_data_list: [{ rotation: 90 }],
    }),
  ).toEqual({ width: 1080, height: 1920 });
});
it("fixed overlay uses the same preview bytes and never persists a draft; missing font fails closed", async () => {
  const p = prefs(),
    direct = await fnfOverlay(p),
    r = await request("/fnf-showcase/overlay", p);
  expect(r.status).toBe(200);
  expect(Buffer.from((await r.json()).png, "base64")).toEqual(direct.png);
  vi.stubEnv("VIDEO_FNF_FONT", join(dir, "missing.ttf"));
  expect((await request("/fnf-showcase/overlay", p)).status).toBe(503);
  vi.unstubAllEnvs();
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.video_projects WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.render_batches WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(0);
});
it("VFR short cut falls back to one AAC encode and validates exact 60fps output", async () => {
  const path = join(dir, "vfr-" + owner + ".mp4");
  await sourceFile(path, true);
  session = new FnfSession(await register(path));
  const range = session.ranges[0];
  session.edit(range.id, 16667, 266667);
  session.name(range.id, "短区間");
  const r = await request("/fnf-showcase/batches", session.snapshot(prefs()));
  expect(r.status).toBe(202);
  const c = await claim(worker());
  expect(
    await executeRender(worker(), storage, c!, {
      directory: dir,
      maxWorkBytes: 1024 ** 3,
      minFreeBytes: 64 * 1024 ** 2,
    }),
  ).toMatchObject({ state: "succeeded" });
  const v = (
    await engine.query(
      "SELECT validation FROM axfluxo_video.render_artifacts WHERE owner_id=$1",
      [owner],
    )
  ).rows[0].validation;
  expect(v).toMatchObject({ frames: 15, audioMode: "encoded" });
}, 60000);
it("admission closed leaves snapshots/jobs/reservations untouched", async () => {
  session.name(session.ranges[0].id, "name");
  const invalid = session.snapshot(prefs());
  invalid.preferences.template.cropTop = 90;
  expect((await request("/fnf-showcase/batches", invalid)).status).toBe(422);
  enabled = false;
  expect(
    (await request("/fnf-showcase/batches", session.snapshot(prefs()))).status,
  ).toBe(503);
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.render_batches WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(0);
});
