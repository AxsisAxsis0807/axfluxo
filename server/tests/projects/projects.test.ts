import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { testEngine, type TestEngine } from "../engine";
import { createVideoApi } from "../../api/app";
import { projectsRouter } from "../../api/projects/router";
import { ApiError } from "../../api/errors";
import {
  newProject,
  ALEO_HASH,
  AV_RENDERER,
  type AllVersionsProject,
} from "../../../src/domain/video/all-versions";
import { allVersionsDocumentSchema } from "../../../src/domain/video/schema";
import { textImage } from "../../worker/templates/all-versions/graphics";
import {
  projectPlan,
  prepareGraphics,
  encodeProjectSegment,
} from "../../worker/templates/all-versions/render";
import { claim } from "../../worker/jobs/queue";
import { executeRender } from "../../worker/render/service";
import { fileHash, probe } from "../../worker/render/process";
import { assemble } from "../../worker/render/encode";
import { validateVideo } from "../../worker/validation/output";
import { probeMedia } from "../../worker/probe/media";
import { generateMedia } from "../../worker/derivatives/generate";
import { FakeStorage } from "../cloud/fake-storage";
let engine: TestEngine,
  dir: string,
  owner: string,
  p: AllVersionsProject,
  storage: Storage,
  source: string,
  cover: string;
class Storage extends FakeStorage {
  async putRender(key: string, path: string) {
    if (this.objects.has(key)) throw new Error("immutable");
    this.objects.set(key, await readFile(path));
  }
}
const api = () =>
  createVideoApi({
    db: engine.asRole("axfluxo_video_api"),
    allowedOrigins: ["https://editor.test"],
    admissionEnabled: () => true,
    unitsPerFrame: 1,
    verify: async (auth) => {
      if (!auth) throw new ApiError(401, "UNAUTHENTICATED");
      return { ownerId: auth };
    },
    projects: projectsRouter({
      db: engine.asRole("axfluxo_video_api"),
      enabled: () => true,
      unitsPerFrame: 1,
    }),
  });
const request = (
  path: string,
  body?: unknown,
  revision = 0,
  auth: string | null = owner,
  key = randomUUID(),
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
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "axfluxo-v5-"));
  engine = testEngine(join(dir, "db"));
  for (const f of [
    "001_video_foundation.sql",
    "002_cloud_library.sql",
    "003_video_preview.sql",
    "004_video_render.sql",
    "005_all_versions_projects.sql",
  ])
    await engine.exec(
      await readFile(
        new URL(`../../db/migrations/${f}`, import.meta.url),
        "utf8",
      ),
    );
}, 30000);
afterAll(async () => {
  await engine?.close();
});
async function media(
  path: string,
  kind: "audio" | "image" | "video",
  mime: string,
) {
  const bytes = await readFile(path),
    hash = createHash("sha256").update(bytes).digest("hex"),
    id = randomUUID(),
    version = randomUUID(),
    key = `originals/${owner}/${version}`;
  storage.objects.set(key, bytes);
  await engine.query(
    "INSERT INTO axfluxo_video.media_assets(id,owner_id,name) VALUES($1,$2,'fixture')",
    [id, owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.media_versions(id,owner_id,asset_id,object_key,hash,size,mime,kind,probe) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}')",
    [version, owner, id, key, hash, bytes.length, mime, kind],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.resource_versions(owner_id,library_id,file_id,version_id,hash,kind) VALUES($1,'cloud',$2,$3,$4,$5)",
    [owner, id, version, hash, kind],
  );
  return { libraryId: "cloud", fileId: id, versionId: version, hash, kind };
}
beforeEach(async () => {
  vi.unstubAllEnvs();
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
  source = join(dir, `audio-${owner}.wav`);
  cover = join(dir, `cover-${owner}.png`);
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=1",
      "-c:a",
      "pcm_s16le",
      "-y",
      source,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=100x100",
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-y",
      cover,
    ],
    { stdio: "ignore" },
  );
  const ref = await media(source, "audio", "audio/wav"),
    image = await media(cover, "image", "image/png");
  p = newProject();
  p.cover = image;
  p.namesText = "Aleo One\nAleo Two";
  p.document = allVersionsDocumentSchema.parse({
    schemaVersion: 1,
    kind: "all-versions",
    id: randomUUID(),
    revision: 0,
    fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
    clips: [
      {
        id: "clip",
        source: ref,
        sourceDurationUs: 1_000_000,
        interval: { startUs: 0, endUs: 1_000_000 },
        markersUs: [500000],
      },
    ],
  });
});
it("JWT boundary, owner, If-Match revision, 409 preservation and immutable history", async () => {
  expect((await request(`/projects/${p.id}`, p, 0, null)).status).toBe(401);
  const staleOwner = await api()(
    new Request(`https://api.test/projects/${p.id}`, {
      headers: { authorization: owner, "x-project-owner": randomUUID() },
    }),
  );
  expect(staleOwner.status).toBe(403);
  expect(
    (await request(`/projects/${p.id}`, { ...p, schemaVersion: 2 })).status,
  ).toBe(400);
  const first = await request(`/projects/${p.id}`, p);
  expect(first.status).toBe(200);
  const incoming = { ...p, namesText: "different" };
  expect((await request(`/projects/${p.id}`, incoming, 0)).status).toBe(409);
  expect(
    (
      await engine.query(
        "SELECT proposed FROM axfluxo_video.video_project_conflicts WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].proposed,
  ).toEqual(incoming);
  expect((await (await request(`/projects/${p.id}`)).json()).project).toEqual(
    p,
  );
  expect((await request(`/projects/${p.id}`, incoming, 1)).status).toBe(200);
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.video_project_revisions WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(2);
  const other = randomUUID();
  await engine.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true)",
    [other],
  );
  expect((await request(`/projects/${p.id}`, undefined, 0, other)).status).toBe(
    404,
  );
  await engine.query(
    "UPDATE axfluxo_video.developer_memberships SET active=false WHERE owner_id=$1",
    [owner],
  );
  expect((await request(`/projects/${p.id}`)).status).toBe(403);
});
it("same idempotency key retains original result across retries; two device writes cannot overwrite", async () => {
  const key = randomUUID();
  const [a, b] = await Promise.all([
    request(`/projects/${p.id}`, p, 0, owner, key),
    request(`/projects/${p.id}`, p, 0, owner, key),
  ]);
  expect(await a.json()).toEqual(await b.json());
  const [c, d] = await Promise.all([
    request(`/projects/${p.id}`, { ...p, namesText: "device A" }, 1),
    request(`/projects/${p.id}`, { ...p, namesText: "device B" }, 1),
  ]);
  expect([c.status, d.status].sort()).toEqual([200, 409]);
});
it("server text PNG pins font/renderer, shrinks long names on one line, supports 1080/1440; missing font fails closed", async () => {
  for (const height of [1080, 1440] as const) {
    p.design.height = height;
    p.namesText = "Aleo One\nAleo Two";
    const short = await textImage(p, 0);
    p.namesText = "Very long name ".repeat(80) + "\nTwo";
    const long = await textImage(p, 0);
    expect(long.fontSize).toBeLessThan(short.fontSize);
    expect(long.width).toBe((height * 16) / 9);
    expect(long.height).toBe(height);
    expect(long.fontHash).toBe(ALEO_HASH);
    expect(long.rendererVersion).toBe(AV_RENDERER);
    expect(long.png.subarray(1, 4).toString()).toBe("PNG");
  }
  vi.stubEnv("VIDEO_ALEO_FONT", join(dir, "missing.ttf"));
  await expect(textImage(p, 0)).rejects.toMatchObject({
    code: "FONT_UNAVAILABLE",
  });
  const wrongFont = join(dir, "wrong-font.ttf");
  await writeFile(wrongFont, "not the pinned font");
  vi.stubEnv("VIDEO_ALEO_FONT", wrongFont);
  await expect(textImage(p, 0)).rejects.toMatchObject({
    code: "FONT_UNAVAILABLE",
  });
  vi.unstubAllEnvs();
  p.namesText = "未対応文字";
  await expect(textImage(p, 0)).rejects.toMatchObject({
    code: "FONT_GLYPH_UNSUPPORTED",
  });
});
it("text endpoint uses exactly the worker PNG bytes", async () => {
  const direct = await textImage(p, 0),
    response = await request("/projects/text-preview", {
      project: p,
      index: 0,
    });
  expect(response.status).toBe(200);
  expect(Buffer.from((await response.json()).png, "base64")).toEqual(
    direct.png,
  );
});
it("project render uses V4 fencing/publication, audio extraction and immutable cover/original pins", async () => {
  await request(`/projects/${p.id}`, p);
  const r = await request(`/projects/${p.id}/render`, {}, 1);
  expect(r.status).toBe(202);
  const batch = await r.json(),
    c = await claim(engine.asRole("axfluxo_video_render"));
  expect(c?.project).toEqual(p);
  const result = await executeRender(
    engine.asRole("axfluxo_video_render"),
    storage,
    c!,
    {
      directory: dir,
      maxWorkBytes: 1024 ** 3,
      minFreeBytes: 64 * 1024 ** 2,
      segmentFrames: 30,
    },
  );
  expect(result.state).toBe("succeeded");
  const output = (
    await engine.query(
      "SELECT * FROM axfluxo_video.render_outputs WHERE job_id=$1",
      [batch.jobs[0].id],
    )
  ).rows;
  expect(output).toHaveLength(1);
  expect(Number(output[0].frame_count)).toBe(60);
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.resource_pins WHERE job_id=$1",
        [c!.job],
      )
    ).rows,
  ).toHaveLength(2);
  const artifact = (
    await engine.query(
      "SELECT o.object_key FROM axfluxo_video.render_objects o JOIN axfluxo_video.render_artifacts a ON a.object_id=o.id WHERE a.output_id=$1",
      [output[0].id],
    )
  ).rows[0];
  const rendered = join(dir, "published-" + owner + ".mp4");
  await writeFile(rendered, storage.objects.get(String(artifact.object_key))!);
  const sample = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      rendered,
      "-vf",
      "select='eq(n,0)+eq(n,9)+eq(n,21)+eq(n,29)+eq(n,30)+eq(n,39)',crop=1600:120:160:864",
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: 5 * 1024 ** 2 },
  );
  const bytesPer = 1600 * 120 * 3;
  const diff = (index: number) => {
    let sum = 0;
    for (let i = 0; i < bytesPer; i++)
      sum += Math.abs(sample[i] - sample[index * bytesPer + i]);
    return sum / bytesPer;
  };
  expect(sample.length).toBe(bytesPer * 6);
  expect(diff(1)).toBeGreaterThan(diff(3) * 2);
  expect(diff(4)).toBeLessThan(diff(1) * 0.2);
  expect(diff(5)).toBeGreaterThan(diff(3) * 2);
  const pcm = (path: string) =>
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        path,
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { maxBuffer: 200000 },
    );
  const originalPcm = pcm(source),
    renderedPcm = pcm(rendered);
  for (const t of [0.05, 0.47, 0.51, 0.9]) {
    let dot = 0,
      aa = 0,
      bb = 0;
    const start = Math.round(t * 48000);
    for (let i = start; i < start + 1024; i++) {
      const a = originalPcm.readInt16LE(i * 2),
        b = renderedPcm.readInt16LE(i * 2);
      dot += a * b;
      aa += a * a;
      bb += b * b;
    }
    expect(dot / Math.sqrt(aa * bb)).toBeGreaterThan(0.98);
    expect(Math.sqrt(bb / aa)).toBeGreaterThan(0.95);
    expect(Math.sqrt(bb / aa)).toBeLessThan(1.05);
  }
  expect(await fileHash(source)).toBe(p.document!.clips[0].source.hash);
  expect(await fileHash(cover)).toBe(p.cover!.hash);
}, 120000);
it("1440p output validates dimensions, CFR, audio sync, and title fade across a checkpoint boundary", async () => {
  p.design.height = 1440;
  p.namesText = "One";
  p.document!.clips[0].markersUs = [];
  p.design.fadeInFrames = 0;
  p.design.fadeOutFrames = 0;
  p.document!.clips[0].interval.endUs = 83333;
  const s = {
      schemaVersion: 1 as const,
      id: "snapshot",
      document: p.document!,
      ranges: [{ startUs: 0, endUs: 83333 }],
      names: ["video.mp4"],
    },
    plan = projectPlan(p, s, 3),
    stage = await mkdtemp(join(dir, "1440-")),
    graphics = await prepareGraphics(p, cover, stage),
    paths = [];
  for (const seg of plan.segments) {
    const path = join(stage, `s${seg.index}.mp4`);
    await encodeProjectSegment(p, seg, plan, graphics, stage, path);
    paths.push(path);
  }
  const final = await assemble(
    plan,
    [{ path: source, info: await probe(source) }],
    paths,
    stage,
    undefined,
    true,
  );
  const v = await validateVideo(final.path, { ...plan, audio: true });
  expect(v.width).toBe(2560);
  expect(v.height).toBe(1440);
  expect(v.frames).toBe(5);
  expect(v.audioSamples).toBeGreaterThanOrEqual(4000);
}, 120000);
it.each([
  ["mp3", "audio/mpeg", "libmp3lame"],
  ["wav", "audio/wav", "pcm_s16le"],
  ["m4a", "audio/mp4", "aac"],
] as const)(
  "verifies %s bytes and generates full audio proxy/waveform",
  async (ext, mime, codec) => {
    const path = join(dir, `${owner}.${ext}`);
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", source, "-c:a", codec, "-y", path],
      { stdio: "ignore" },
    );
    const result = await probeMedia(path, (await stat(path)).size, mime);
    expect(result.kind).toBe("audio");
    const stage = await mkdtemp(join(dir, "proxy-")),
      derived = await generateMedia(path, stage, {
        id: randomUUID(),
        hash: await fileHash(path),
        durationUs: result.durationUs!,
      });
    expect(derived.metadata.durationUs).toBeGreaterThan(900000);
    expect(
      JSON.parse(await readFile(derived.files[2].path, "utf8")).levels[0].peaks
        .length,
    ).toBeGreaterThan(0);
  },
  30000,
);

it.each(["mp4", "mov"])(
  "extracts verified %s audio while retaining the immutable original",
  async (ext) => {
    const video = join(dir, `${owner}.${ext}`);
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=60:duration=1",
        "-i",
        source,
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-c:a",
        "aac",
        "-shortest",
        "-y",
        video,
      ],
      { stdio: "ignore" },
    );
    const mime = ext === "mov" ? "video/quicktime" : "video/mp4";
    expect((await probeMedia(video, (await stat(video)).size, mime)).kind).toBe(
      "video",
    );
    const ref = await media(video, "video", mime);
    p.document!.clips[0].source = ref;
    await request(`/projects/${p.id}`, p);
    const response = await request(`/projects/${p.id}/render`, {}, 1);
    expect(response.status).toBe(202);
    const c = await claim(engine.asRole("axfluxo_video_render"));
    expect(
      await executeRender(engine.asRole("axfluxo_video_render"), storage, c!, {
        directory: dir,
        maxWorkBytes: 1024 ** 3,
        minFreeBytes: 64 * 1024 ** 2,
      }),
    ).toMatchObject({ state: "succeeded" });
    expect(await fileHash(video)).toBe(ref.hash);
  },
  120000,
);
