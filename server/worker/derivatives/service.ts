import { randomUUID, createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import type { Database } from "../../db/database";
import type { MultipartStorage } from "../../storage/multipart";
import { scoped } from "../../api/assets/library";
import { generateMedia } from "./generate";
export type DerivedStorage = MultipartStorage & {
  putDerived(
    key: string,
    path: string,
    size: number,
    mime: string,
    sha256: string,
  ): Promise<void>;
};
type Plan = {
  metadata: Awaited<ReturnType<typeof generateMedia>>["metadata"];
  files: {
    kind: string;
    key: string;
    size: number;
    hash: string;
    mime: string;
    id: string;
  }[];
};
async function fileHash(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function generatePreview(
  db: Database,
  storage: DerivedStorage,
  owner: string,
  version: string,
) {
  const token = randomUUID();
  const job = await scoped(db, owner, async (sql) => {
    const r = await sql.query(
      "UPDATE axfluxo_video.media_preview_jobs SET state='generating',lease_token=$3,lease_until=now()+interval '5 minutes' WHERE owner_id=$1 AND version_id=$2 AND state IN ('queued','generating') AND (lease_until IS NULL OR lease_until<now()) RETURNING *",
      [owner, version, token],
    );
    return r.rows[0];
  });
  if (!job) return false;
  const dir = await mkdtemp(join(tmpdir(), "axfluxo-preview-")),
    source = join(dir, "original"),
    stop = new AbortController();
  const timer = setInterval(() => {
    void scoped(db, owner, (sql) =>
      sql.query(
        "UPDATE axfluxo_video.media_preview_jobs SET lease_until=now()+interval '5 minutes' WHERE owner_id=$1 AND version_id=$2 AND lease_token=$3 RETURNING id",
        [owner, version, token],
      ),
    )
      .then((r) => {
        if (!r.rows.length) stop.abort();
      })
      .catch(() => stop.abort());
  }, 30000);
  try {
    const row = await scoped(
      db,
      owner,
      async (sql) =>
        (
          await sql.query(
            "SELECT * FROM axfluxo_video.media_versions WHERE owner_id=$1 AND id=$2",
            [owner, version],
          )
        ).rows[0],
    );
    if (!row) throw new Error("SOURCE_MISSING");
    const body = await storage.stream(String(row.object_key), stop.signal);
    let received = 0;
    async function* bounded() {
      for await (const chunk of body) {
        received += chunk.byteLength;
        if (received > Number(row.size)) throw new Error("SOURCE_MISSING");
        yield chunk;
      }
    }
    await pipeline(
      bounded(),
      createWriteStream(source, { flags: "wx", mode: 0o600 }),
      { signal: stop.signal },
    );
    if (
      (await stat(source)).size !== Number(row.size) ||
      (await fileHash(source)) !== row.hash
    )
      throw new Error("SOURCE_MISSING");
    const probe = row.probe as { durationUs: number };
    const generated = await generateMedia(
      source,
      dir,
      { id: version, hash: String(row.hash), durationUs: probe.durationUs },
      stop.signal,
    );
    let plan = job.plan as Plan | null;
    const measured = await Promise.all(
      generated.files.map(async (f) => ({
        kind: f.kind,
        size: (await stat(f.path)).size,
        hash: await fileHash(f.path),
        mime: f.mime,
        path: f.path,
      })),
    );
    if (!plan) {
      const prefix = `derivatives/${owner}/${version}/${token}`;
      plan = {
        metadata: generated.metadata,
        files: measured.map(({ kind, size, hash, mime }) => ({
          kind,
          size,
          hash,
          mime,
          key: `${prefix}/${kind}`,
          id: randomUUID(),
        })),
      };
      const bytes = plan.files.reduce((n, f) => n + f.size, 0);
      await scoped(db, owner, async (sql) => {
        const reserved = await sql.query(
          "UPDATE axfluxo_video.media_quotas SET reserved_bytes=reserved_bytes+$2 WHERE owner_id=$1 AND NOT blocked AND $2::bigint<=limit_bytes-reserved_bytes-used_bytes RETURNING owner_id",
          [owner, bytes],
        );
        if (!reserved.rows.length) throw new Error("PREVIEW_FAILED");
        const updated = await sql.query(
          "UPDATE axfluxo_video.media_preview_jobs SET plan=$4::jsonb,reserved_bytes=$5 WHERE owner_id=$1 AND version_id=$2 AND lease_token=$3 RETURNING id",
          [owner, version, token, JSON.stringify(plan), bytes],
        );
        if (!updated.rows.length) throw new Error("PREVIEW_FAILED");
      });
    }
    for (const file of plan.files) {
      const local = measured.find((f) => f.kind === file.kind)!;
      if (local.hash !== file.hash || local.size !== file.size)
        throw new Error("PREVIEW_FAILED");
      const existing = await storage.head(file.key);
      if (existing) {
        if (existing.size !== file.size) throw new Error("PREVIEW_FAILED");
      } else
        await storage.putDerived(
          file.key,
          local.path,
          file.size,
          file.mime,
          file.hash,
        );
    }
    await scoped(db, owner, async (sql) => {
      const r = await sql.query(
        "SELECT * FROM axfluxo_video.media_preview_jobs WHERE owner_id=$1 AND version_id=$2 AND lease_token=$3 FOR UPDATE",
        [owner, version, token],
      );
      if (!r.rows.length) throw new Error("PREVIEW_FAILED");
      for (const f of plan!.files)
        await sql.query(
          "INSERT INTO axfluxo_video.media_derivatives(id,owner_id,version_id,object_key,hash,kind) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
          [f.id, owner, version, f.key, f.hash, f.kind],
        );
      await sql.query(
        "UPDATE axfluxo_video.media_quotas SET reserved_bytes=reserved_bytes-$2,used_bytes=used_bytes+$2 WHERE owner_id=$1",
        [owner, r.rows[0].reserved_bytes],
      );
      await sql.query(
        "UPDATE axfluxo_video.usage_budgets SET reserved_units=reserved_units-$2,consumed_units=consumed_units+$2 WHERE owner_id=$1",
        [owner, r.rows[0].compute_units],
      );
      await sql.query(
        "UPDATE axfluxo_video.media_preview_jobs SET state='ready',metadata=$4::jsonb,lease_token=NULL,lease_until=NULL WHERE owner_id=$1 AND version_id=$2 AND lease_token=$3",
        [owner, version, token, JSON.stringify(plan!.metadata)],
      );
    });
    return true;
  } catch (error) {
    await scoped(db, owner, (sql) =>
      sql.query(
        "UPDATE axfluxo_video.media_preview_jobs SET state='failed',error_code=$4,lease_token=NULL,lease_until=NULL WHERE owner_id=$1 AND version_id=$2 AND lease_token=$3",
        [
          owner,
          version,
          token,
          error instanceof Error && error.message === "SOURCE_MISSING"
            ? "SOURCE_MISSING"
            : "PREVIEW_FAILED",
        ],
      ),
    ).catch(() => undefined);
    return false;
  } finally {
    clearInterval(timer);
    stop.abort();
    await rm(dir, { recursive: true, force: true });
  }
}
