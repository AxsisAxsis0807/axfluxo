import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  multipartLayout,
  uploadStartSchema,
  type PartPlan,
  type UploadView,
} from "../../../src/domain/cloud-library/media";
import type { Database, Sql, Row } from "../../db/database";
import type { MultipartStorage, StoredPart } from "../../storage/multipart";
import { ApiError } from "../errors";
import { digest, idempotent } from "../jobs";
import { folderOwned, scoped } from "../assets/library";
export type SessionRow = Row & {
  id: string;
  owner_id: string;
  name: string;
  size: string | number;
  expected_hash: string;
  declared_mime: string;
  object_key: string;
  multipart_id: string | null;
  part_size: string | number;
  part_count: number;
  state: UploadView["state"];
  parts: Record<string, PartPlan>;
  lease_token: string | null;
  lease_until: Date | null;
  expired: boolean;
  leased: boolean;
  error_code: string | null;
  asset_id: string | null;
  version_id: string | null;
  accounted: boolean;
  folder_id: string | null;
};
export async function sessionRow(
  sql: Sql,
  owner: string,
  id: string,
): Promise<SessionRow> {
  const r = await sql.query<SessionRow>(
    "SELECT *,expires_at<now() AS expired, lease_until>now() AS leased FROM axfluxo_video.upload_sessions WHERE owner_id=$1 AND id=$2 FOR UPDATE",
    [owner, id],
  );
  if (!r.rows.length) throw new ApiError(404, "NOT_FOUND");
  return r.rows[0];
}
function view(row: SessionRow, parts: StoredPart[] = []): UploadView {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    size: Number(row.size),
    sha256: row.expected_hash,
    partSize: Number(row.part_size),
    partCount: row.part_count,
    state: row.state,
    parts: Object.values(row.parts)
      .sort((a, b) => a.number - b.number)
      .map((p) => ({
        ...p,
        etag:
          parts.find(
            (s) =>
              s.number === p.number &&
              s.size === p.size &&
              s.etag.replaceAll('"', "").toLowerCase() === p.md5,
          )?.etag ?? null,
      })),
    error: row.error_code,
    assetId: row.asset_id,
    versionId: row.version_id,
  };
}
export class UploadService {
  constructor(
    public readonly db: Database,
    public readonly storage: MultipartStorage,
    public readonly enabled: () => boolean,
  ) {}
  async start(
    owner: string,
    input: z.infer<typeof uploadStartSchema>,
    key: string,
  ) {
    if (!this.enabled()) throw new ApiError(503, "UPLOADS_DISABLED");
    const result = await scoped(this.db, owner, (sql) =>
      idempotent(
        sql,
        owner,
        key,
        digest({ path: "/cloud/uploads", body: input }),
        async () => {
          await folderOwned(sql, owner, input.folderId);
          const quota = await sql.query(
            "SELECT limit_bytes,blocked FROM axfluxo_video.media_quotas WHERE owner_id=$1 FOR UPDATE",
            [owner],
          );
          if (!quota.rows.length || quota.rows[0].limit_bytes === null)
            throw new ApiError(503, "QUOTA_UNCONFIGURED");
          const reserved = await sql.query(
            "UPDATE axfluxo_video.media_quotas SET reserved_bytes=reserved_bytes+$2 WHERE owner_id=$1 AND NOT blocked AND $2::bigint<=limit_bytes-used_bytes-reserved_bytes RETURNING owner_id",
            [owner, input.size],
          );
          if (!reserved.rows.length) throw new ApiError(409, "QUOTA_EXCEEDED");
          const id = randomUUID(),
            layout = multipartLayout(input.size);
          await sql.query(
            "INSERT INTO axfluxo_video.upload_sessions(id,owner_id,folder_id,name,size,expected_hash,declared_mime,object_key,part_size,part_count,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'creating')",
            [
              id,
              owner,
              input.folderId,
              input.name,
              input.size,
              input.sha256,
              input.mime,
              `originals/${owner}/${id}`,
              layout.partSize,
              layout.partCount,
            ],
          );
          return { status: 202, body: { id } };
        },
      ),
    );
    const id = (result.body as { id: string }).id;
    await this.initialize(owner, id);
    return this.status(owner, id);
  }
  async initialize(owner: string, id: string) {
    const claim = await this.claim(owner, id, ["creating"]);
    if (!claim) return;
    try {
      const ids = await this.storage.findUploads(claim.row.object_key);
      const multipart =
        ids[0] ?? (await this.storage.create(claim.row.object_key, owner, id));
      await scoped(this.db, owner, async (sql) => {
        const row = await sessionRow(sql, owner, id);
        if (row.lease_token !== claim.token)
          throw new ApiError(409, "UPLOAD_BUSY");
        await sql.query(
          "UPDATE axfluxo_video.upload_sessions SET state='uploading',multipart_id=$3,lease_token=NULL,lease_until=NULL WHERE owner_id=$1 AND id=$2",
          [owner, id, multipart],
        );
      });
    } catch (e) {
      await this.release(owner, id, claim.token);
      if (e instanceof ApiError) throw e;
      throw new ApiError(503, "STORAGE_UNAVAILABLE");
    }
  }
  async claim(
    owner: string,
    id: string,
    states: string[],
    transition?: string,
  ) {
    return scoped(this.db, owner, async (sql) => {
      const row = await sessionRow(sql, owner, id);
      if (!states.includes(row.state)) return null;
      if (row.lease_token && row.leased) return null;
      const token = randomUUID();
      await sql.query(
        "UPDATE axfluxo_video.upload_sessions SET state=$3,lease_token=$4,lease_until=now()+interval '5 minutes' WHERE owner_id=$1 AND id=$2",
        [owner, id, transition ?? row.state, token],
      );
      return { row, token };
    });
  }
  async release(owner: string, id: string, token: string, state?: string) {
    await scoped(this.db, owner, (sql) =>
      sql.query(
        "UPDATE axfluxo_video.upload_sessions SET lease_token=NULL,lease_until=NULL,state=coalesce($4,state) WHERE owner_id=$1 AND id=$2 AND lease_token=$3",
        [owner, id, token, state ?? null],
      ),
    );
  }
  async status(owner: string, id: string): Promise<UploadView> {
    let row = await scoped(this.db, owner, (sql) => sessionRow(sql, owner, id));
    if (
      row.expired &&
      ["creating", "uploading", "aborting"].includes(row.state)
    )
      return this.abort(owner, id, true);
    if (row.state === "creating") {
      await this.initialize(owner, id);
      row = await scoped(this.db, owner, (sql) => sessionRow(sql, owner, id));
    }
    let parts: StoredPart[] = [];
    if (row.state === "uploading" && row.multipart_id) {
      try {
        parts = await this.storage.parts(row.object_key, row.multipart_id);
      } catch {
        throw new ApiError(503, "STORAGE_UNAVAILABLE");
      }
    }
    return scoped(this.db, owner, async (sql) =>
      view(await sessionRow(sql, owner, id), parts),
    );
  }
  async sign(owner: string, id: string, plan: PartPlan) {
    if (!this.enabled()) throw new ApiError(503, "UPLOADS_DISABLED");
    const row = await scoped(this.db, owner, async (sql) => {
      const row = await sessionRow(sql, owner, id);
      if (row.expired) throw new ApiError(410, "UPLOAD_EXPIRED");
      if (row.state !== "uploading" || !row.multipart_id)
        throw new ApiError(409, "UPLOAD_BUSY");
      const expected = Math.min(
        Number(row.part_size),
        Number(row.size) - (plan.number - 1) * Number(row.part_size),
      );
      if (plan.number > row.part_count || plan.size !== expected)
        throw new ApiError(409, "UPLOAD_PART_MISMATCH");
      const old = row.parts[plan.number];
      if (old && digest(old) !== digest(plan))
        throw new ApiError(409, "UPLOAD_FILE_MISMATCH");
      row.parts[plan.number] = plan;
      await sql.query(
        "UPDATE axfluxo_video.upload_sessions SET parts=$3::jsonb WHERE owner_id=$1 AND id=$2",
        [owner, id, JSON.stringify(row.parts)],
      );
      return row;
    });
    const signed = await this.storage.signPart(
      row.object_key,
      row.multipart_id!,
      plan.number,
      plan.md5,
    );
    await scoped(this.db, owner, async (sql) => {
      const latest = await sessionRow(sql, owner, id);
      if (latest.state !== "uploading") throw new ApiError(409, "UPLOAD_BUSY");
    });
    return signed;
  }
  async complete(owner: string, id: string) {
    const current = await scoped(this.db, owner, (sql) =>
      sessionRow(sql, owner, id),
    );
    if (["verifying", "ready", "failed"].includes(current.state))
      return view(current);
    if (
      current.state === "expired" ||
      (current.expired && current.state === "uploading")
    )
      throw new ApiError(410, "UPLOAD_EXPIRED");
    if (!["uploading", "completing"].includes(current.state))
      throw new ApiError(409, "UPLOAD_BUSY");
    const claim = await this.claim(
      owner,
      id,
      ["uploading", "completing"],
      "completing",
    );
    if (!claim) return this.status(owner, id);
    let beforeComplete = true;
    try {
      let head = await this.storage.head(current.object_key);
      if (!head) {
        const parts = await this.storage.parts(
          current.object_key,
          current.multipart_id!,
        );
        const plans = Object.values(current.parts);
        if (
          parts.length !== current.part_count ||
          plans.length !== current.part_count ||
          parts.some((p) => {
            const plan = current.parts[p.number];
            return (
              !plan ||
              plan.size !== p.size ||
              plan.md5 !== p.etag.replaceAll('"', "").toLowerCase()
            );
          })
        )
          throw new ApiError(409, "UPLOAD_PART_MISMATCH");
        beforeComplete = false;
        await this.storage.complete(
          current.object_key,
          current.multipart_id!,
          parts.sort((a, b) => a.number - b.number),
        );
        head = await this.storage.head(current.object_key);
      }
      if (!head) throw new ApiError(503, "STORAGE_UNAVAILABLE");
      await scoped(this.db, owner, async (sql) => {
        const row = await sessionRow(sql, owner, id);
        if (row.lease_token !== claim.token)
          throw new ApiError(409, "UPLOAD_BUSY");
        if (head.size !== Number(row.size)) {
          await sql.query(
            "UPDATE axfluxo_video.media_quotas SET blocked=true WHERE owner_id=$1",
            [owner],
          );
          await sql.query(
            "UPDATE axfluxo_video.upload_sessions SET state='failed',error_code='SIZE_MISMATCH',lease_token=NULL,lease_until=NULL WHERE owner_id=$1 AND id=$2",
            [owner, id],
          );
          return;
        }
        if (!row.accounted)
          await sql.query(
            "UPDATE axfluxo_video.media_quotas SET reserved_bytes=reserved_bytes-$2,used_bytes=used_bytes+$2 WHERE owner_id=$1",
            [owner, row.size],
          );
        await sql.query(
          "UPDATE axfluxo_video.upload_sessions SET state='verifying',accounted=true,lease_token=NULL,lease_until=NULL WHERE owner_id=$1 AND id=$2",
          [owner, id],
        );
      });
      return this.status(owner, id);
    } catch (e) {
      await this.release(
        owner,
        id,
        claim.token,
        e instanceof ApiError &&
          e.code === "UPLOAD_PART_MISMATCH" &&
          beforeComplete
          ? "uploading"
          : undefined,
      );
      if (e instanceof ApiError) throw e;
      throw new ApiError(503, "STORAGE_UNAVAILABLE");
    }
  }
  async abort(owner: string, id: string, expired = false) {
    const current = await scoped(this.db, owner, (sql) =>
      sessionRow(sql, owner, id),
    );
    if (["aborted", "expired"].includes(current.state)) return view(current);
    if (!["creating", "uploading", "aborting"].includes(current.state))
      throw new ApiError(409, "UPLOAD_ALREADY_COMPLETED");
    const claim = await this.claim(
      owner,
      id,
      ["creating", "uploading", "aborting"],
      "aborting",
    );
    if (!claim) throw new ApiError(409, "UPLOAD_BUSY");
    try {
      if (await this.storage.head(current.object_key))
        throw new ApiError(409, "UPLOAD_ALREADY_COMPLETED");
      const ids = current.multipart_id
        ? [current.multipart_id]
        : await this.storage.findUploads(current.object_key);
      for (const multipart of ids)
        await this.storage.abort(current.object_key, multipart);
      if (await this.storage.head(current.object_key))
        throw new ApiError(409, "UPLOAD_ALREADY_COMPLETED");
      await scoped(this.db, owner, async (sql) => {
        const row = await sessionRow(sql, owner, id);
        if (row.lease_token !== claim.token)
          throw new ApiError(409, "UPLOAD_BUSY");
        await sql.query(
          "UPDATE axfluxo_video.media_quotas SET reserved_bytes=reserved_bytes-$2 WHERE owner_id=$1",
          [owner, row.size],
        );
        await sql.query(
          "UPDATE axfluxo_video.upload_sessions SET state=$3,lease_token=NULL,lease_until=NULL WHERE owner_id=$1 AND id=$2",
          [owner, id, expired ? "expired" : "aborted"],
        );
      });
      return this.status(owner, id);
    } catch (e) {
      await this.release(owner, id, claim.token);
      if (e instanceof ApiError) throw e;
      throw new ApiError(503, "STORAGE_UNAVAILABLE");
    }
  }
}
