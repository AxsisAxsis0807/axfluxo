import { randomUUID, createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Database, Sql, Row } from "../db/database";
import { ApiError } from "../api/errors";
import { GoogleDrive } from "../google-drive/google";
import { sha256 } from "../google-drive/security";
import { probeMedia } from "../worker/probe/media";
import { ownerTransaction, driveCredentials, invalidateDriveAccess } from "./credentials";
import { DriveTransfer, DRIVE_CHUNK } from "./transfer";
import type { DrivePolicy } from "./config";
export type Inventory = Row & {
  id: string;
  owner_id: string;
  file_id: string | null;
  account_id: string;
  parent_id: string;
  namespace: string;
  object_key: string;
  size: number | string;
  hash: string;
  mime: string;
  name: string;
  state: string;
  offset_bytes: number | string;
  session_cipher: string | null;
  version_id: string | null;
  asset_id: string | null;
  lease_token: string | null;
  probe: Record<string, unknown> | null;
};
export class DriveCloud {
  constructor(
    readonly db: Database,
    readonly google: GoogleDrive,
    readonly policy: DrivePolicy,
  ) {}
  owner<T>(owner: string, work: (sql: Sql) => Promise<T>) {
    return ownerTransaction(this.db, owner, work);
  }
  async databaseRoom() {
    if (!this.policy.dbLimitBytes) return; // Only isolated test/development policy permits unknown DB size.
    const size = (
      await this.db.transaction((sql) =>
        sql.query("SELECT pg_database_size(current_database())::text AS bytes"),
      )
    ).rows[0]?.bytes;
    if (!size || Number(size) + 16 * 1024 ** 2 > this.policy.dbLimitBytes)
      throw new ApiError(503, "DRIVE_DB_HELD");
  }
  googleFor(owner: string) {
    return new GoogleDrive(this.google.config, async (url, init) => {
      if (new URL(String(url)).hostname === "www.googleapis.com")
        await this.event(owner, "api", 0);
      const response = await this.google.transport(url, init);
      if (response.status === 401) {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth?.startsWith("Bearer "))
          invalidateDriveAccess(this.db, owner, auth.slice("Bearer ".length));
      }
      return response;
    });
  }
  transfer(owner: string) {
    const metered = this.googleFor(owner);
    return new DriveTransfer(
      metered,
      driveCredentials(this.db, metered, owner),
    );
  }
  event(
    owner: string,
    kind: "upload" | "download" | "api" | "export",
    bytes: number,
    key = randomUUID(),
  ): Promise<unknown> {
    return this.owner(owner, (sql) =>
      sql.query(
        "INSERT INTO axfluxo_video.drive_usage(owner_id,event_key,kind,bytes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [owner, key, kind, bytes],
      ),
    );
  }
  row(owner: string, id: string) {
    return this.owner(owner, async (sql) => {
      const r = (
        await sql.query<Inventory>(
          "SELECT * FROM axfluxo_video.drive_inventory WHERE owner_id=$1 AND id=$2",
          [owner, id],
        )
      ).rows[0];
      if (!r) throw new ApiError(404, "NOT_FOUND");
      return r;
    });
  }
  async ensureFolder(owner: string, namespace = "original") {
    const c = await this.owner(
      owner,
      async (sql) =>
        (
          await sql.query(
            "SELECT * FROM axfluxo_video.drive_connections WHERE owner_id=$1",
            [owner],
          )
        ).rows[0],
    );
    if (!c?.connected || !c.root_id || !c.queue_id || !c.completed_id)
      throw new ApiError(401, "DRIVE_RECONNECT_REQUIRED");
    const api = this.googleFor(owner);
    const token = await driveCredentials(this.db, api, owner)();
    const role = namespace === "output" ? "completed" : "queue",
      id = String(namespace === "output" ? c.completed_id : c.queue_id);
    try {
      const root = await api.get(token, String(c.root_id)),
        folder = await api.get(token, id);
      if (
        root.trashed ||
        folder.trashed ||
        root.mimeType !== "application/vnd.google-apps.folder" ||
        folder.mimeType !== "application/vnd.google-apps.folder" ||
        root.appProperties?.axfluxoOwner !== owner ||
        root.appProperties?.axfluxoRole !== "root" ||
        folder.appProperties?.axfluxoOwner !== owner ||
        folder.appProperties?.axfluxoRole !== role ||
        !folder.parents?.includes(String(c.root_id))
      )
        throw new ApiError(409, "DRIVE_FOLDER_RECOVERY_REQUIRED");
    } catch (error) {
      if (error instanceof ApiError && error.code === "DRIVE_RESOURCE_MISSING")
        throw new ApiError(409, "DRIVE_FOLDER_RECOVERY_REQUIRED");
      throw error;
    }
    return c;
  }
  async reserve(
    owner: string,
    p: {
      key: string;
      size: number;
      hash: string;
      mime: string;
      name: string;
      namespace?: string;
      job?: string;
      objectKey?: string;
    },
  ): Promise<Inventory> {
    if (!this.policy.enabled()) throw new ApiError(503, "DRIVE_CLOUD_HELD");
    // Client-side preflight is advisory. The API must reject originals that
    // this worker cannot possibly verify before reserving Drive storage.
    // Render/candidate/output objects use the separately reserved job budget.
    if (
      (p.namespace ?? "original") === "original" &&
      (p.size > this.policy.maxFileBytes ||
        p.size + this.policy.marginBytes > this.policy.maxWorkBytes)
    )
      throw new ApiError(413, "DRIVE_VERIFY_DISK_TOO_SMALL");
    const existing = await this.owner(
      owner,
      async (sql) =>
        (
          await sql.query<Inventory>(
            "SELECT * FROM axfluxo_video.drive_inventory WHERE owner_id=$1 AND operation_key=$2",
            [owner, p.key],
          )
        ).rows[0],
    );
    const compatible = (r: Inventory) => {
      if (
        Number(r.size) !== p.size ||
        r.hash !== p.hash ||
        r.mime !== p.mime ||
        r.namespace !== (p.namespace ?? "original") ||
        (p.objectKey && r.object_key !== p.objectKey)
      )
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT");
      return r;
    };
    if (existing) return compatible(existing);
    await this.databaseRoom();
    const folders = await this.ensureFolder(owner, p.namespace);
    const capacity = await this.transfer(owner).capacity();
    return this.owner(owner, async (sql) => {
      const c = (
        await sql.query(
          "SELECT * FROM axfluxo_video.drive_connections WHERE owner_id=$1 FOR UPDATE",
          [owner],
        )
      ).rows[0];
      if (
        !c?.connected ||
        c.account_id !== capacity.account ||
        c.generation !== folders.generation ||
        !c.queue_id ||
        !c.completed_id
      )
        throw new ApiError(409, "DRIVE_CONNECTION_CHANGED");
      const duplicate = (
        await sql.query<Inventory>(
          "SELECT * FROM axfluxo_video.drive_inventory WHERE owner_id=$1 AND operation_key=$2",
          [owner, p.key],
        )
      ).rows[0];
      if (duplicate) return compatible(duplicate);
      await sql.query(
        "INSERT INTO axfluxo_video.drive_capacity(owner_id,limit_bytes,observed_free) VALUES($1,$2,$3) ON CONFLICT(owner_id) DO UPDATE SET observed_free=$3,observed_at=now()",
        [owner, this.policy.limitBytes, capacity.free],
      );
      // A render object consumes the job's pre-reserved peak before requesting extra bytes.
      let credit = 0;
      if (p.job) {
        const q = (
          await sql.query(
            "SELECT remaining FROM axfluxo_video.drive_job_capacity WHERE owner_id=$1 AND job_id=$2 FOR UPDATE",
            [owner, p.job],
          )
        ).rows[0];
        credit = Math.min(Number(q?.remaining ?? 0), p.size);
        if (credit)
          await sql.query(
            "UPDATE axfluxo_video.drive_job_capacity SET remaining=remaining-$3::bigint WHERE owner_id=$1 AND job_id=$2",
            [owner, p.job, credit],
          );
      }
      const room = await sql.query(
        "UPDATE axfluxo_video.drive_capacity SET reserved_bytes=reserved_bytes+$2::bigint WHERE owner_id=$1 AND used_bytes+reserved_bytes+$2::bigint+$3::bigint<=LEAST(limit_bytes,$4::bigint) AND reserved_bytes+$2::bigint+$3::bigint<=observed_free RETURNING owner_id",
        [owner, p.size, this.policy.marginBytes, this.policy.limitBytes],
      );
      if (!room.rows.length) throw new ApiError(507, "DRIVE_QUOTA_EXCEEDED");
      const id = randomUUID();
      return (
        await sql.query<Inventory>(
          "INSERT INTO axfluxo_video.drive_inventory(id,owner_id,operation_key,object_key,namespace,job_id,parent_id,account_id,name,mime,size,hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
          [
            id,
            owner,
            p.key,
            p.objectKey ?? "drive:" + id,
            p.namespace ?? "original",
            p.job ?? null,
            p.namespace === "output" ? c.completed_id : c.queue_id,
            c.account_id,
            p.name,
            p.mime,
            p.size,
            p.hash,
          ],
        )
      ).rows[0];
    });
  }
  async lease(owner: string, id: string) {
    const token = randomUUID();
    const row = await this.owner(
      owner,
      async (sql) =>
        (
          await sql.query<Inventory>(
            "UPDATE axfluxo_video.drive_inventory SET lease_token=$3,lease_until=now()+interval '5 minutes' WHERE owner_id=$1 AND id=$2 AND state<>'ready' AND (lease_until IS NULL OR lease_until<now()) RETURNING *",
            [owner, id, token],
          )
        ).rows[0],
    );
    if (!row) throw new ApiError(409, "DRIVE_TRANSFER_BUSY");
    return { row, token };
  }
  async update(
    owner: string,
    id: string,
    token: string,
    text: string,
    values: unknown[] = [],
  ) {
    const result = await this.owner(owner, (sql) =>
      sql.query(
        `UPDATE axfluxo_video.drive_inventory SET ${text} WHERE owner_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>now() RETURNING *`,
        [owner, id, token, ...values],
      ),
    );
    if (!result.rows.length) throw new ApiError(409, "DRIVE_LEASE_LOST");
    return result.rows[0] as Inventory;
  }
  async release(owner: string, id: string, token: string) {
    await this.owner(owner, (sql) =>
      sql.query(
        "UPDATE axfluxo_video.drive_inventory SET lease_token=NULL,lease_until=NULL WHERE owner_id=$1 AND id=$2 AND lease_token=$3",
        [owner, id, token],
      ),
    );
  }
  async remoteIdentity(owner: string, row: Inventory) {
    await this.ensureFolder(owner, row.namespace);
    if (!row.file_id) throw new ApiError(409, "DRIVE_NOT_READY");
    const m = await this.transfer(owner).metadata(row.file_id);
    if (!m.revisionId) throw new ApiError(503, "DRIVE_REVISION_UNAVAILABLE");
    if (
      (row.state === "ready" &&
        row.remote_version &&
        row.remote_version !== m.version) ||
      m.id !== row.file_id ||
      m.trashed ||
      !m.parents.includes(row.parent_id) ||
      m.size !== Number(row.size) ||
      m.appProperties.axfluxoOwner !== owner ||
      m.appProperties.axfluxoSha256 !== row.hash
    )
      throw new ApiError(409, "DRIVE_IDENTITY_MISMATCH");
    return m;
  }
  /** Reconcile only a known DB ID; never list/delete existing user files. */
  async reconcile(owner: string, row: Inventory, token: string) {
    const transfer = this.transfer(owner);
    if (!row.file_id) {
      const api = this.googleFor(owner);
      const [id] = await api.ids(
        await driveCredentials(this.db, api, owner)(),
        1,
      );
      row = await this.update(owner, row.id, token, "file_id=$4", [id]);
    }
    if (row.session_cipher) {
      const status = await transfer.session(
        this.google.config.vault.open(
          row.session_cipher,
          owner + ":upload:" + row.id,
        ),
        Number(row.size),
      );
      if (!status.expired)
        return this.update(
          owner,
          row.id,
          token,
          "offset_bytes=$4,state=CASE WHEN $5 THEN 'verifying' ELSE 'uploading' END",
          [status.offset, status.complete],
        );
    }
    // A lost final response can leave the file complete even after the session expires.
    try {
      await this.remoteIdentity(owner, row);
      return this.update(
        owner,
        row.id,
        token,
        "state='verifying',offset_bytes=size",
      );
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.code !== "DRIVE_RESOURCE_MISSING"
      )
        throw error;
    }
    const session = await transfer.begin({
      id: row.file_id!,
      parent: row.parent_id,
      owner,
      size: Number(row.size),
      hash: row.hash,
      mime: row.mime,
      name: row.name,
    });
    return this.update(
      owner,
      row.id,
      token,
      "session_cipher=$4,offset_bytes=0,state='uploading'",
      [this.google.config.vault.seal(session, owner + ":upload:" + row.id)],
    );
  }
  async status(owner: string, id: string, reconcile = true) {
    let row = await this.row(owner, id);
    if (reconcile && row.state === "uploading") {
      const claim = await this.lease(owner, id);
      try {
        row = await this.reconcile(owner, claim.row, claim.token);
      } finally {
        await this.release(owner, id, claim.token);
      }
    }
    return this.view(row);
  }
  view(row: Inventory) {
    return {
      id: row.id,
      state: row.state,
      offset: Number(row.offset_bytes),
      size: Number(row.size),
      sha256: row.hash,
      error: row.error_code ?? null,
      reference:
        row.state === "ready" && row.version_id
          ? {
              libraryId: "cloud",
              fileId: row.asset_id,
              versionId: row.version_id,
              hash: row.hash,
              kind: row.probe?.kind,
            }
          : null,
      probe: row.probe,
    };
  }
  async chunk(
    owner: string,
    id: string,
    offset: number,
    data: Uint8Array,
    hash: string,
    signal?: AbortSignal,
  ) {
    if (!data.length || data.length > DRIVE_CHUNK || sha256(data) !== hash)
      throw new ApiError(422, "DRIVE_CHUNK_INVALID");
    const prior = await this.owner(
      owner,
      async (sql) =>
        (
          await sql.query(
            "SELECT hash,size FROM axfluxo_video.drive_chunks WHERE owner_id=$1 AND object_id=$2 AND offset_bytes=$3",
            [owner, id, offset],
          )
        ).rows[0],
    );
    if (prior && (prior.hash !== hash || Number(prior.size) !== data.length))
      throw new ApiError(409, "DRIVE_CHUNK_CONFLICT");
    const initial = await this.row(owner, id);
    if (initial.namespace !== "original")
      throw new ApiError(403, "DRIVE_ORIGINAL_REQUIRED");
    if (initial.state === "ready" || initial.state === "verifying") {
      if (!prior) throw new ApiError(409, "DRIVE_OFFSET_INVALID");
      return this.view(initial);
    }
    const { row, token } = await this.lease(owner, id);
    try {
      const current = await this.reconcile(owner, row, token);
      if (current.state === "verifying") return this.view(current);
      if (offset < Number(current.offset_bytes) && prior)
        return this.view(current);
      if (
        offset !== Number(current.offset_bytes) ||
        offset + data.length > Number(row.size) ||
        (offset + data.length < Number(row.size) && data.length % 262144 !== 0)
      )
        throw new ApiError(409, "DRIVE_OFFSET_INVALID");
      await this.owner(owner, (sql) =>
        sql.query(
          "INSERT INTO axfluxo_video.drive_chunks(owner_id,object_id,offset_bytes,size,hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [owner, id, offset, data.length, hash],
        ),
      );
      const journal = await this.owner(
        owner,
        async (sql) =>
          (
            await sql.query(
              "SELECT hash,size FROM axfluxo_video.drive_chunks WHERE owner_id=$1 AND object_id=$2 AND offset_bytes=$3",
              [owner, id, offset],
            )
          ).rows[0],
      );
      if (journal.hash !== hash || Number(journal.size) !== data.length)
        throw new ApiError(409, "DRIVE_CHUNK_CONFLICT");
      const session = this.google.config.vault.open(
        current.session_cipher!,
        owner + ":upload:" + id,
      );
      await this.event(owner, "upload", data.length);
      // On timeout/5xx leave the reservation and immutable chunk journal; status probes Google next time.
      const result = await this.transfer(owner).session(
        session,
        Number(row.size),
        data,
        offset,
        signal,
      );
      if (result.expired) {
        await this.update(
          owner,
          id,
          token,
          "session_cipher=NULL,offset_bytes=0",
        );
        throw new ApiError(409, "DRIVE_SESSION_EXPIRED");
      }
      const saved = await this.update(
        owner,
        id,
        token,
        "offset_bytes=$4,state=CASE WHEN $5 THEN 'verifying' ELSE 'uploading' END",
        [result.offset, result.complete],
      );
      return this.view(saved);
    } finally {
      await this.release(owner, id, token);
    }
  }
  async verify(owner: string, id: string, signal?: AbortSignal) {
    const initial = await this.row(owner, id);
    if (initial.state === "ready") return true;
    if (initial.state !== "verifying") return false;
    const { row, token } = await this.lease(owner, id);
    let dir: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = new AbortController();
    const relay = () => stop.abort();
    signal?.addEventListener("abort", relay, { once: true });
    if (signal?.aborted) stop.abort();
    try {
      if (Number(row.verify_runs) >= 3)
        throw new ApiError(409, "DRIVE_VERIFY_LIMIT");
      await this.update(owner, id, token, "verify_runs=verify_runs+1");
      const fs = await statfs(this.policy.directory);
      if (
        Number(row.size) + this.policy.marginBytes > this.policy.maxWorkBytes ||
        fs.bavail * fs.bsize < Number(row.size) + this.policy.minFreeBytes
      )
        throw new ApiError(503, "DRIVE_DISK_HELD");
      dir = await mkdtemp(join(this.policy.directory, "drive-verify-"));
      timer = setInterval(() => {
        void this.update(
          owner,
          id,
          token,
          "lease_until=now()+interval '5 minutes'",
        ).catch(() => stop.abort());
      }, 15000);
      const before = await this.remoteIdentity(owner, row),
        path = join(dir, "source"),
        h = createHash("sha256");
      let size = 0;
      const remote = await this.transfer(owner).stream(
        row.file_id!,
        stop.signal,
        undefined,
        before.revisionId,
      );
      const recordDownload = (bytes: number) =>
        this.event(owner, "download", bytes);
      async function* checked() {
        try {
          for await (const b of remote.body) {
            stop.signal.throwIfAborted();
            size += b.length;
            if (size > Number(row.size))
              throw new ApiError(422, "DRIVE_INTEGRITY_FAILED");
            h.update(b);
            yield b;
          }
        } finally {
          await recordDownload(size);
        }
      }
      await pipeline(
        checked(),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
        { signal: stop.signal },
      );
      if (size !== Number(row.size) || h.digest("hex") !== row.hash)
        throw new ApiError(422, "DRIVE_INTEGRITY_FAILED");
      const probe = await probeMedia(path, size, row.mime, stop.signal);
      const after = await this.remoteIdentity(owner, row);
      if (before.version !== after.version)
        throw new ApiError(409, "DRIVE_IDENTITY_MISMATCH");
      await this.owner(owner, async (sql) => {
        const locked = (
          await sql.query(
            "SELECT id FROM axfluxo_video.drive_inventory WHERE owner_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>now() AND state='verifying' FOR UPDATE",
            [owner, id, token],
          )
        ).rows[0];
        if (!locked) throw new ApiError(409, "DRIVE_LEASE_LOST");
        let version = (
          await sql.query(
            "SELECT id,asset_id FROM axfluxo_video.media_versions WHERE owner_id=$1 AND hash=$2",
            [owner, row.hash],
          )
        ).rows[0];
        if (!version) {
          const asset = randomUUID(),
            v = randomUUID();
          await sql.query(
            "INSERT INTO axfluxo_video.media_assets(id,owner_id,name) VALUES($1,$2,$3)",
            [asset, owner, row.name],
          );
          await sql.query(
            "INSERT INTO axfluxo_video.media_versions(id,owner_id,asset_id,object_key,hash,size,mime,kind,probe) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
            [
              v,
              owner,
              asset,
              row.object_key,
              row.hash,
              size,
              probe.mime,
              probe.kind,
              JSON.stringify(probe),
            ],
          );
          await sql.query(
            "INSERT INTO axfluxo_video.resource_versions(owner_id,library_id,file_id,version_id,hash,kind) VALUES($1,'cloud',$2,$3,$4,$5)",
            [owner, asset, v, row.hash, probe.kind],
          );
          version = { id: v, asset_id: asset };
        }
        await sql.query(
          "UPDATE axfluxo_video.drive_inventory SET state='ready',verified_at=now(),asset_id=$4,version_id=$5,probe=$6::jsonb,remote_version=$7,remote_revision=$8,error_code=NULL WHERE owner_id=$1 AND id=$2 AND lease_token=$3",
          [
            owner,
            id,
            token,
            version.asset_id,
            version.id,
            JSON.stringify(probe),
            after.version,
            after.revisionId,
          ],
        );
        await sql.query(
          "UPDATE axfluxo_video.drive_capacity SET reserved_bytes=reserved_bytes-$2::bigint,used_bytes=used_bytes+$2::bigint WHERE owner_id=$1",
          [owner, size],
        );
      });
      return true;
    } catch (error) {
      if (!signal?.aborted)
        await this.update(owner, id, token, "state='held',error_code=$4", [
          error instanceof ApiError ? error.code : "DRIVE_VERIFY_FAILED",
        ]).catch(() => undefined);
      throw error;
    } finally {
      if (timer) clearInterval(timer);
      stop.abort();
      signal?.removeEventListener("abort", relay);
      await this.release(owner, id, token);
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }
}
