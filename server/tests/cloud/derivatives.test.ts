import { beforeAll, afterAll, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  generateMedia,
  inspect,
  decimalUs,
} from "../../worker/derivatives/generate";
import {
  generatePreview,
  type DerivedStorage,
} from "../../worker/derivatives/service";
import { previewAccess } from "../../api/assets/preview";
import { testEngine, type TestEngine } from "../engine";
import { FakeStorage } from "./fake-storage";
let dir: string, engine: TestEngine;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "axfluxo-derivative-test-"));
  engine = testEngine(join(dir, "db"));
  for (const name of [
    "001_video_foundation.sql",
    "002_cloud_library.sql",
    "003_video_preview.sql",
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
function make(name: string, rate: string, extra: string[] = [], audio = false) {
  const path = join(dir, name);
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=160x90:rate=${rate}:duration=1`,
      ...(audio
        ? [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=1",
          ]
        : []),
      ...extra,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      path,
    ],
    { stdio: "ignore" },
  );
  return path;
}
function pts(path: string) {
  const text = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "frame=best_effort_timestamp_time",
      "-of",
      "csv=p=0",
      path,
    ],
    { encoding: "utf8" },
  );
  return text
    .split("\n")
    .map((s) => s.split(",")[0])
    .filter((s) => /^\d/.test(s))
    .map((s) => decimalUs(s));
}
it.each(["30000/1001", "30", "60000/1001", "60"])(
  "generates full-length Safari proxy and preserves %s source PTS",
  async (rate) => {
    const source = make(`source-${rate.replace("/", "-")}.mp4`, rate),
      stage = await mkdtemp(join(dir, "stage-")),
      result = await generateMedia(source, stage, {
        id: randomUUID(),
        hash: "a".repeat(64),
        durationUs: 1100000,
      });
    const input = pts(source),
      output = pts(result.files[0].path);
    expect(output).toHaveLength(input.length);
    for (let i = 0; i < input.length; i++)
      expect(
        Math.abs(input[i] - input[0] - (output[i] - output[0])),
      ).toBeLessThanOrEqual(2);
    expect(result.metadata.durationUs).toBeGreaterThanOrEqual(950000);
    const info = await inspect(result.files[0].path);
    expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({
      time_base: "1/1000000",
    });
  },
  20000,
);
it("retains VFR spacing, normalizes rotation and makes three bounded waveform resolutions", async () => {
  const vfr = make(
      "vfr.mp4",
      "60",
      ["-vf", "select='if(lt(t,0.5),not(mod(n,2)),1)'", "-fps_mode", "vfr"],
      true,
    ),
    stage = await mkdtemp(join(dir, "vfr-")),
    result = await generateMedia(vfr, stage, {
      id: randomUUID(),
      hash: "b".repeat(64),
      durationUs: 1000000,
    });
  const input = pts(vfr),
    output = pts(result.files[0].path);
  expect(output).toHaveLength(input.length);
  expect(
    new Set(input.slice(1).map((n, i) => Math.round((n - input[i]) / 1000)))
      .size,
  ).toBeGreaterThan(1);
  for (let i = 0; i < input.length; i++)
    expect(
      Math.abs(input[i] - input[0] - output[i] + output[0]),
    ).toBeLessThanOrEqual(2);
  const wave = JSON.parse(await readFile(result.files[2].path, "utf8"));
  expect(wave.levels).toHaveLength(3);
  expect(
    wave.levels.every(
      (l: { peaks: number[] }) =>
        l.peaks.length <= 200000 && l.peaks.some((n) => Math.abs(n) > 0.1),
    ),
  ).toBe(true);
  const rotated = join(dir, "rotate.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      vfr,
      "-c",
      "copy",
      "-metadata:s:v:0",
      "rotate=90",
      "-y",
      rotated,
    ],
    { stdio: "ignore" },
  );
  // Patch the standard tkhd display matrix: ffmpeg versions differ in whether
  // a rotate tag on stream-copy writes the matrix at all.
  const rotatedBytes = Buffer.from(await readFile(rotated));
  function matrix(start: number, end: number): boolean {
    for (let pos = start; pos + 8 <= end;) {
      const size = rotatedBytes.readUInt32BE(pos),
        type = rotatedBytes.toString("ascii", pos + 4, pos + 8);
      if (size < 8 || pos + size > end) break;
      if (type === "tkhd") {
        const at = pos + (rotatedBytes[pos + 8] === 1 ? 60 : 48);
        [0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824].forEach((n, i) =>
          rotatedBytes.writeInt32BE(n, at + 4 * i),
        );
        return true;
      }
      if (["moov", "trak"].includes(type) && matrix(pos + 8, pos + size))
        return true;
      pos += size;
    }
    return false;
  }
  expect(matrix(0, rotatedBytes.length)).toBe(true);
  await writeFile(rotated, rotatedBytes);
  const rotate = await generateMedia(
    rotated,
    await mkdtemp(join(dir, "rotated-")),
    { id: randomUUID(), hash: "c".repeat(64), durationUs: 1000000 },
  );
  expect(Math.abs(rotate.metadata.rotationDegrees)).toBe(90);
  expect(rotate.metadata.width).toBeLessThan(rotate.metadata.height);
}, 20000);
it("queues durably, authorizes fixed versions and publishes immutable derivatives without changing originals", async () => {
  const owner = randomUUID(),
    other = randomUUID(),
    asset = randomUUID(),
    version = randomUUID(),
    source = make("publish.mp4", "30", [], true),
    bytes = await readFile(source),
    hash = createHash("sha256").update(bytes).digest("hex");
  await engine.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true),($2,true)",
    [owner, other],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.usage_budgets(owner_id,limit_units) VALUES($1,100000)",
    [owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.media_quotas(owner_id,limit_bytes) VALUES($1,100000000)",
    [owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.media_assets(id,owner_id,name) VALUES($1,$2,'source')",
    [asset, owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.media_versions(id,owner_id,asset_id,object_key,hash,size,mime,kind,probe) VALUES($1,$2,$3,$4,$5,$6,'video/mp4','video',$7::jsonb)",
    [
      version,
      owner,
      asset,
      `originals/${owner}/${version}`,
      hash,
      bytes.length,
      JSON.stringify({ durationUs: 1000000 }),
    ],
  );
  const store = new FakeStorage() as FakeStorage & DerivedStorage;
  store.objects.set(`originals/${owner}/${version}`, bytes);
  store.putDerived = async (key, path) => {
    expect(key.startsWith("derivatives/")).toBe(true);
    if (store.objects.has(key)) throw new Error("immutable");
    store.objects.set(key, await readFile(path));
  };
  const config = {
    db: engine.asRole("axfluxo_video_api"),
    storage: store,
    enabled: () => true,
    unitsPerSecond: 1,
  };
  await expect(
    previewAccess({ ...config, unitsPerSecond: undefined }, owner, version),
  ).rejects.toMatchObject({ code: "PROXY_NOT_READY" });
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.media_preview_jobs WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(0);
  await expect(previewAccess(config, owner, version)).rejects.toMatchObject({
    code: "PROXY_NOT_READY",
  });
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.media_preview_jobs WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(1);
  await expect(previewAccess(config, other, version)).rejects.toMatchObject({
    code: "SOURCE_MISSING",
  });
  expect(
    await generatePreview(
      engine.asRole("axfluxo_video_probe"),
      store,
      owner,
      version,
    ),
  ).toBe(true);
  const ready = await previewAccess(config, owner, version);
  expect(ready.hash).toBe(hash);
  expect(ready.proxy).toBeTruthy();
  expect(hash).toBe(
    createHash("sha256")
      .update(store.objects.get(`originals/${owner}/${version}`)!)
      .digest("hex"),
  );
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.media_derivatives WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(3);
}, 20000);
