import { mkdtemp, rm, stat, statfs, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "../../db/database";
import {
  fenced,
  heartbeat,
  finishFailure,
  progress,
  publish,
  type Claim,
} from "../jobs/queue";
import { codeOf, RenderError } from "../jobs/errors";
import {
  projectPlan,
  prepareGraphics,
  encodeProjectSegment,
} from "../templates/all-versions/render";
import {
  isFnfShowcase,
  FNF_RENDERER,
  FNF_FONT_HASH,
} from "../../../src/domain/video/fnf-showcase";
import { prepareFnf, encodeFnfSegment } from "../templates/fnf-showcase/render";
import { renderPlan, RENDER_VERSION } from "./plan";
import { probe } from "./process";
import { encodeSegment, assemble, type Input } from "./encode";
import { validateVideo } from "../validation/output";
import { download, storeObject, type RenderStorage } from "./objects";
import { decimalUs } from "../derivatives/generate";
import { digest } from "../../api/jobs";
export type RenderLimits = {
  directory: string;
  maxWorkBytes: number;
  minFreeBytes: number;
  segmentFrames?: number;
};
async function treeSize(dir: string): Promise<number> {
  let size = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    size += e.isDirectory() ? await treeSize(p) : (await stat(p)).size;
  }
  return size;
}
async function memoryKills() {
  try {
    return Number(
      /oom_kill (\d+)/.exec(
        await readFile("/sys/fs/cgroup/memory.events", "utf8"),
      )?.[1] ?? 0,
    );
  } catch {
    return 0;
  }
}
export async function executeRender(
  db: Database,
  storage: RenderStorage,
  c: Claim,
  limits: RenderLimits,
) {
  let dir: string;
  try {
    dir = await mkdtemp(join(limits.directory, "render-"));
  } catch (error) {
    const code = codeOf(error);
    await finishFailure(db, c, code).catch(() => undefined);
    return { state: "stopped" as const, code };
  }
  const stop = new AbortController();
  let active = true,
    beating = false,
    stopCode: RenderError | undefined;
  const oomBefore = await memoryKills();
  async function disk(extra = 0) {
    const fs = await statfs(dir);
    if (
      fs.bavail * fs.bsize < limits.minFreeBytes + extra ||
      (await treeSize(dir)) + extra > limits.maxWorkBytes
    )
      throw new RenderError("DISK_FULL");
  }
  const timer = setInterval(() => {
    if (!active || beating) return;
    beating = true;
    void heartbeat(db, c)
      .then(() => disk())
      .catch((e) => {
        stopCode =
          e instanceof RenderError ? e : new RenderError("DATABASE_TRANSIENT");
        stop.abort();
      })
      .finally(() => {
        beating = false;
      });
  }, 15000);
  try {
    const showcase = isFnfShowcase(c.snapshot) ? c.snapshot : undefined;
    const plan = c.project
      ? projectPlan(c.project, c.snapshot, limits.segmentFrames)
      : renderPlan(c.snapshot, c.rangeIndex, c.mode, limits.segmentFrames);
    // Encoder build changes invalidate checkpoints. Bounded textual ffmpeg version is part of plan.
    const { execFile } = await import("node:child_process");
    const version = await new Promise<string>((resolve, reject) =>
      execFile(
        "ffmpeg",
        ["-version"],
        {
          maxBuffer: 65536,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            LANG: "C",
            NODE_ENV: "production",
          },
        },
        (err, out) =>
          err ? reject(new RenderError("INPUT_UNSUPPORTED")) : resolve(out),
      ),
    );
    plan.hash = digest({
      plan: plan.hash,
      version: RENDER_VERSION,
      encoder: version,
      ...(showcase ? { showcase } : {}),
    });
    await progress(db, c, 0, plan.frames);
    const inputs: Input[] = [];
    // Original keys come exclusively from immutable owner/version/hash catalogue. Never from URLs.
    for (let i = 0; i < plan.snapshot.document.clips.length; i++) {
      if (!plan.pieces.some((p) => p.clipIndex === i)) continue;
      const clip = plan.snapshot.document.clips[i],
        r = clip.source;
      if (r.kind !== "video" && !(c.project && r.kind === "audio"))
        throw new RenderError("INPUT_UNSUPPORTED");
      const row = await fenced(
        db,
        c,
        async (sql) =>
          (
            await sql.query(
              "SELECT v.* FROM axfluxo_video.media_versions v JOIN axfluxo_video.resource_versions r ON r.owner_id=v.owner_id AND r.version_id=v.id::text AND r.file_id=v.asset_id::text AND r.hash=v.hash WHERE v.owner_id=$1 AND v.id::text=$2 AND v.hash=$3 AND r.library_id=$4 AND r.file_id=$5 AND r.kind=$6",
              [c.owner, r.versionId, r.hash, r.libraryId, r.fileId, r.kind],
            )
          ).rows[0],
      );
      if (!row) throw new RenderError("INPUT_MISSING");
      await disk(Number(row.size));
      const path = join(dir, `source-${i}`);
      await download(
        storage,
        String(row.object_key),
        path,
        Number(row.size),
        r.hash,
        stop.signal,
      );
      const info = await probe(path, stop.signal);
      if (
        !info.streams.some(
          (t) => t.codec_type === (c.project ? "audio" : "video"),
        ) ||
        Math.abs(decimalUs(info.format.duration) - clip.sourceDurationUs) > 1
      )
        throw new RenderError("INPUT_CORRUPT");
      inputs[i] = { path, info };
    }
    let graphics: Awaited<ReturnType<typeof prepareGraphics>> | undefined;
    if (c.project) {
      const ref = c.project.cover!;
      const cover = await fenced(
        db,
        c,
        async (sql) =>
          (
            await sql.query(
              "SELECT * FROM axfluxo_video.media_versions WHERE owner_id=$1 AND id::text=$2 AND asset_id::text=$3 AND hash=$4 AND kind='image'",
              [c.owner, ref.versionId, ref.fileId, ref.hash],
            )
          ).rows[0],
      );
      if (!cover) throw new RenderError("INPUT_MISSING");
      await disk(Number(cover.size));
      const path = join(dir, "cover");
      await download(
        storage,
        String(cover.object_key),
        path,
        Number(cover.size),
        ref.hash,
        stop.signal,
      );
      graphics = await prepareGraphics(c.project, path, dir);
    }
    const fnfGraphics = showcase
      ? await prepareFnf(showcase.preferences, dir)
      : undefined;
    const paths: string[] = [];
    for (const s of plan.segments) {
      stop.signal.throwIfAborted();
      await heartbeat(db, c);
      await disk();
      const path = join(dir, `segment-${s.index}.mp4`);
      const checkpoint = await fenced(
        db,
        c,
        async (sql) =>
          (
            await sql.query(
              "SELECT * FROM axfluxo_video.render_objects WHERE owner_id=$1 AND job_id=$2 AND plan_hash=$3 AND segment_index=$4 AND kind='segment' AND ready ORDER BY created_at LIMIT 1",
              [c.owner, c.job, plan.hash, s.index],
            )
          ).rows[0],
      );
      if (checkpoint) {
        await disk(Number(checkpoint.size));
        try {
          await download(
            storage,
            String(checkpoint.object_key),
            path,
            Number(checkpoint.size),
            String(checkpoint.hash),
            stop.signal,
          );
          await validateVideo(path, { ...plan, frames: s.frames }, stop.signal);
        } catch (e) {
          if (
            [
              "STORAGE_TRANSIENT",
              "STORAGE_REJECTED",
              "DISK_FULL",
              "OUT_OF_MEMORY",
              "LEASE_LOST",
            ].includes(codeOf(e))
          )
            throw e;
          throw new RenderError("CHECKPOINT_CORRUPT");
        }
      } else {
        if (c.project && graphics)
          await encodeProjectSegment(
            c.project,
            s,
            plan,
            graphics,
            dir,
            path,
            stop.signal,
          );
        else if (showcase && fnfGraphics)
          await encodeFnfSegment(
            inputs[s.clipIndex],
            s,
            plan,
            showcase.preferences,
            fnfGraphics,
            path,
            stop.signal,
          );
        else
          await encodeSegment(inputs[s.clipIndex], s, plan, path, stop.signal);
        const v = await validateVideo(
          path,
          { ...plan, frames: s.frames },
          stop.signal,
        );
        await storeObject(
          db,
          storage,
          c,
          {
            path,
            hash: v.sha256,
            size: v.size,
            kind: "segment",
            planHash: plan.hash,
            index: s.index,
          },
          stop.signal,
        );
      }
      paths.push(path);
      await progress(db, c, s.outputStartFrame + s.frames, plan.frames);
      await disk();
    }
    // Reserve seekable disk for joined video + candidate. ENOSPC also stops into held state.
    const segmentBytes = (await Promise.all(paths.map((p) => stat(p)))).reduce(
      (n, s) => n + s.size,
      0,
    );
    await disk(segmentBytes * 2 + Math.ceil((plan.frames / 60) * 50000));
    const result = await assemble(
      plan,
      inputs,
      paths,
      dir,
      stop.signal,
      !!c.project || !!showcase,
    );
    const validation = await validateVideo(
      result.path,
      { ...plan, audio: true },
      stop.signal,
    );
    const common = {
      path: result.path,
      hash: validation.sha256,
      size: validation.size,
      planHash: plan.hash,
    };
    await storeObject(
      db,
      storage,
      c,
      { ...common, kind: "candidate" },
      stop.signal,
    );
    const object = await storeObject(
      db,
      storage,
      c,
      { ...common, kind: "output" },
      stop.signal,
    );
    const output = await publish(
      db,
      c,
      object,
      {
        ...validation,
        audioMode: result.audioMode,
        renderer: RENDER_VERSION,
        ...(showcase
          ? { templateRenderer: FNF_RENDERER, fontHash: FNF_FONT_HASH }
          : {}),
        ...(c.project
          ? {
              templateRenderer: c.project.design.rendererVersion,
              fontHash: c.project.design.fontHash,
            }
          : {}),
      },
      plan.frames,
    );
    return { state: "succeeded" as const, output };
  } catch (error) {
    let code = stopCode?.code ?? codeOf(error);
    if ((await memoryKills()) > oomBefore) code = "OUT_OF_MEMORY";
    if (code !== "LEASE_LOST")
      await finishFailure(db, c, code).catch(() => undefined);
    return { state: "stopped" as const, code };
  } finally {
    active = false;
    clearInterval(timer);
    stop.abort();
    await rm(dir, { recursive: true, force: true });
  }
}
