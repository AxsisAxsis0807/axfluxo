import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Database } from "../db/database";
import { postgresDatabase } from "../db/postgres";
import { isEntrypoint, runService } from "../runtime/lifecycle";
import { ConfigurationError } from "../runtime/config";
import { exportLimits } from "../../src/domain/cloud-export/schema";
import { exportWorkerConfiguration, type ExportWorkerConfig } from "./config";
import { blobForOwner, readBlob, storeBlob } from "./storage";
import {
  claim,
  fenced,
  finishFailure,
  findOutputBlob,
  heartbeat,
  progress,
  publish,
  purgeExpired,
  type Claim,
} from "./queue";
import {
  exportFileHash,
  renderExport,
  type ExportCover,
  type ExportSource,
} from "./render";
import { ExportError, exportCodeOf } from "./errors";

async function treeSize(dir: string): Promise<number> {
  let size = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    size += entry.isDirectory() ? await treeSize(path) : (await stat(path)).size;
  }
  return size;
}

/** Bounded work directory: never fill the worker disk, leave room for FFmpeg temporaries. */
async function checkDisk(
  dir: string,
  limits: Pick<ExportWorkerConfig, "minFreeBytes" | "maxWorkBytes">,
  extra = 0,
) {
  const space = await statfs(dir);
  if (space.bavail * space.bsize < limits.minFreeBytes + extra)
    throw new ExportError("EXPORT_DISK_FULL");
  if ((await treeSize(dir)) + extra > limits.maxWorkBytes)
    throw new ExportError("EXPORT_DISK_FULL");
}

/** Downloads one immutable blob, verifying size and SHA-256 rather than trusting metadata. */
async function downloadBlob(
  db: Database,
  owner: string,
  blobId: string,
  path: string,
  kind: "clip" | "cover",
  signal: AbortSignal,
) {
  const row = await blobForOwner(db, owner, blobId);
  if (kind === "cover" && row.kind !== "image")
    throw new ExportError("EXPORT_INPUT_MISSING");
  if (kind === "clip" && row.kind !== "video")
    throw new ExportError("EXPORT_INPUT_MISSING");
  const size = Number(row.size);
  const hash = createHash("sha256");
  let received = 0;
  async function* verified() {
    for await (const chunk of readBlob(db, owner, row)) {
      signal.throwIfAborted();
      received += chunk.byteLength;
      if (received > size) throw new ExportError("EXPORT_INPUT_CORRUPT");
      hash.update(chunk);
      yield chunk;
    }
  }
  await pipeline(
    verified(),
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  if (received !== size || hash.digest("hex") !== row.sha256)
    throw new ExportError("EXPORT_HASH_MISMATCH");
  return { blobId, path, hash: row.sha256, size };
}

async function* fileChunks(path: string, size: number) {
  const chunkSize = exportLimits.chunkBytes;
  let buffer = Buffer.alloc(0),
    total = 0;
  for await (const data of createReadStream(path)) {
    total += (data as Buffer).byteLength;
    if (total > size) throw new ExportError("EXPORT_OUTPUT_INVALID");
    buffer = Buffer.concat([buffer, data as Buffer]);
    while (buffer.byteLength >= chunkSize) {
      yield buffer.subarray(0, chunkSize);
      buffer = buffer.subarray(chunkSize);
    }
  }
  if (buffer.byteLength) yield buffer;
}

type Rendered = Awaited<ReturnType<typeof renderExport>>;

/**
 * One pass: claim at most one job, render it, publish only after full validation.
 * Returns whether work was claimed. All failures are recorded by fixed code only.
 */
export async function runExportPass(
  db: Database,
  config: Pick<
    ExportWorkerConfig,
    | "workDirectory"
    | "maxWorkBytes"
    | "minFreeBytes"
    | "segmentFrames"
    | "sessionTimeoutMs"
    | "maxOwnerBytes"
  >,
  signal: AbortSignal,
  render: typeof renderExport = renderExport,
): Promise<boolean> {
  const job: Claim | null = await claim(db);
  if (!job) return false;
  const dir = await mkdtemp(join(config.workDirectory, "export-"));
  const stop = new AbortController();
  const relay = () => stop.abort();
  signal.addEventListener("abort", relay, { once: true });
  if (signal.aborted) stop.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop.abort();
  }, config.sessionTimeoutMs);
  let beating = false;
  let outputBlobId: string | null = null;
  const heartbeatTimer = setInterval(() => {
    if (beating || stop.signal.aborted) return;
    beating = true;
    void heartbeat(db, job)
      .then(() => checkDisk(dir, config))
      .catch(() => stop.abort())
      .finally(() => {
        beating = false;
      });
  }, 15000);
  try {
    await checkDisk(dir, config);
    const sources: ExportSource[] = [];
    for (const clip of job.spec.clips) {
      await checkDisk(dir, config, config.minFreeBytes);
      sources.push(
        await downloadBlob(
          db,
          job.owner,
          clip.blobId,
          join(dir, `source-${sources.length}`),
          "clip",
          stop.signal,
        ),
      );
    }
    const coverBlob: ExportCover = await downloadBlob(
      db,
      job.owner,
      job.spec.coverBlobId,
      join(dir, "cover"),
      "cover",
      stop.signal,
    );
    const rendered: Rendered = await render({
      jobId: job.job,
      spec: job.spec,
      directory: dir,
      sources,
      cover: coverBlob,
      segmentFrames: config.segmentFrames,
      signal: stop.signal,
      onProgress: (frames) => progress(db, job, frames),
    });
    stop.signal.throwIfAborted();
    if (rendered.size > exportLimits.maxOutputBytes)
      throw new ExportError("EXPORT_LIMIT_EXCEEDED");
    await checkDisk(dir, config);
    const existing = await findOutputBlob(
      db,
      job.owner,
      rendered.sha256,
      rendered.size,
    );
    outputBlobId = existing
      ? existing.id
      : await storeBlob(
          db,
          job.owner,
          {
            id: randomUUID(),
            kind: "output",
            sha256: rendered.sha256,
            size: rendered.size,
            chunks: fileChunks(rendered.path, rendered.size),
          },
          config.maxOwnerBytes,
        );
    stop.signal.throwIfAborted();
    if ((await exportFileHash(rendered.path)) !== rendered.sha256)
      throw new ExportError("EXPORT_OUTPUT_INVALID");
    await publish(db, job, {
      blobId: outputBlobId,
      size: rendered.size,
      sha256: rendered.sha256,
      validation: {
        width: rendered.width,
        height: rendered.height,
        frames: rendered.frames,
        durationUs: rendered.durationUs,
      },
    });
    return true;
  } catch (error) {
    const code: string = stop.signal.aborted && !timedOut
      ? "EXPORT_CANCELLED"
      : timedOut
        ? "EXPORT_TIMEOUT"
        : exportCodeOf(error);
    if (code !== "EXPORT_LEASE_LOST")
      await finishFailure(
        db,
        job,
        new ExportError(code as ReturnType<typeof exportCodeOf>),
      ).catch(() => undefined);
    return true;
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeatTimer);
    signal.removeEventListener("abort", relay);
    stop.abort();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runExportWorker(
  config: ExportWorkerConfig,
  signal: AbortSignal,
) {
  await mkdir(config.workDirectory, { recursive: true, mode: 0o700 });
  const db = postgresDatabase(
    {
      connectionString: config.databaseUrl,
      max: 1,
      ssl: config.tls.ssl,
    },
    "axfluxo_export_worker",
  );
  let idle = 0;
  try {
    while (!signal.aborted) {
      let worked = false;
      try {
        worked = await runExportPass(db, config, signal);
      } catch {
        // Never log driver errors, paths, tokens or media names.
        worked = false;
      }
      if (worked) {
        idle = 0;
        continue;
      }
      // Retention runs while idle so stale jobs never fill the free 1GB database.
      if (idle++ % 60 === 0)
        await purgeExpired(db, config.retentionHours).catch(() => undefined);
      await sleep(config.pollMs, signal);
    }
  } finally {
    await db.close();
  }
}

if (isEntrypoint(import.meta.url, ["export-worker.mjs", "cloud-export/worker.ts"])) {
  void runService(
    async (signal) => {
      const config = exportWorkerConfiguration(process.env);
      await runExportWorker(config, signal);
      return async () => undefined;
    },
    process.env,
  ).catch((error: unknown) => {
    if (error instanceof ConfigurationError)
      process.stderr.write(error.message + "\n");
    process.stderr.write(
      "Cloud export worker startup/operation failed. Verify worker configuration.\n",
    );
    process.exitCode = 1;
  });
}

export { fenced };
