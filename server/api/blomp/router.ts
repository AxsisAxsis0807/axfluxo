import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  blompFile,
  blompStart,
  partLength,
} from "../../../src/domain/blomp/storage";
import type { Database, Sql } from "../../db/database";
import type { BlompStorage } from "../../storage/blomp";
import { jsonBody } from "../app";
import type { VerifyToken } from "../auth";
import { ApiError } from "../errors";
import { requireMembership } from "../jobs";

type Storage = Pick<
  BlompStorage,
  | "location"
  | "newReference"
  | "create"
  | "findUploads"
  | "parts"
  | "sign"
  | "complete"
  | "abort"
  | "head"
  | "stream"
>;
type FileRow = {
  id: string;
  owner_id: string;
  provider: "blomp";
  location: string;
  object_key: string;
  role: "originals" | "outputs";
  name: string;
  mime: string;
  sha256: string;
  size: string;
  project_id: string | null;
  job_id: string | null;
  version: 1;
  status: z.infer<typeof blompFile>["status"];
  upload_id: string | null;
  signed_until: Date | null;
  lease: string | null;
  lease_until: Date | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
};
type Capacity = {
  capacity: string;
  measured_used: string;
  margin: string;
  committed: string;
  reserved: string;
  observed_at: Date;
  verification_remaining: string;
  upload_remaining: string;
  download_remaining: string;
};
const files = "axfluxo_video.blomp_files";
const capacity = "axfluxo_video.blomp_capacity";
const maxSnapshotAge = 15 * 60 * 1000;
const empty = z.strictObject({});
const view = (file: FileRow) =>
  blompFile.parse({
    id: file.id,
    provider: file.provider,
    role: file.role,
    name: file.name,
    mime: file.mime,
    sha256: file.sha256,
    size: Number(file.size),
    projectId: file.project_id,
    jobId: file.job_id,
    version: file.version,
    status: file.status,
    createdAt: file.created_at.toISOString(),
    updatedAt: file.updated_at.toISOString(),
    expiresAt: file.expires_at.toISOString(),
  });

function remaining(row: Capacity | undefined) {
  if (
    !row ||
    +row.observed_at > Date.now() ||
    Date.now() - +row.observed_at > maxSnapshotAge
  )
    return null;
  return (
    Number(row.capacity) -
    Number(row.margin) -
    Number(row.measured_used) -
    Number(row.committed) -
    Number(row.reserved)
  );
}

export function blompRouter({
  db,
  storage,
  writes,
  verify,
}: {
  db: Database;
  storage: Storage | null;
  writes: () => boolean;
  verify: VerifyToken;
}) {
  return async (request: Request, owner: string) => {
    const scoped = <T>(work: (sql: Sql) => Promise<T>) =>
      db.transaction(async (sql) => {
        await requireMembership(sql, owner);
        return work(sql);
      });
    const reply = (body: unknown, status = 200) => ({ status, body });
    const url = new URL(request.url);
    const path = url.pathname;
    const post = request.method === "POST";
    if (!post && request.method !== "GET") throw new ApiError(404, "NOT_FOUND");
    const unauthorized = () => new ApiError(409, "BLOMP_STATE_CONFLICT");
    const held = () => new ApiError(503, "BLOMP_WRITES_HELD");
    if (!storage) {
      await scoped(async () => undefined);
      if (request.method !== "GET" || path !== "/storage/blomp/overview")
        throw held();
      return reply({
        state: "disabled",
        capacity: null,
        measuredUsed: null,
        estimatedUsed: null,
        available: null,
        reserved: 0,
        verifiedAt: null,
      });
    }
    await scoped(async (sql) => {
      const { rows } = await sql.query(
        `INSERT INTO axfluxo_video.blomp_requests AS r VALUES ($1,clock_timestamp(),1)
        ON CONFLICT(owner_id) DO UPDATE SET
        count=CASE WHEN r.window_start < clock_timestamp()-interval '1 minute' THEN 1 ELSE least(r.count+1,121) END,
        window_start=CASE WHEN r.window_start < clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE r.window_start END
        RETURNING count`,
        [owner],
      );
      return Number(rows[0].count);
    }).then((count) => {
      if (count > 120) throw new ApiError(429, "RATE_LIMITED");
    });
    const loadCapacity = async (sql: Sql, lock: boolean) =>
      (
        await sql.query<Capacity>(
          `SELECT * FROM ${capacity} WHERE location=$1 ${lock ? "FOR UPDATE" : ""}`,
          [storage.location],
        )
      ).rows[0];
    if (request.method === "GET" && path === "/storage/blomp/overview") {
      const row = await scoped((sql) => loadCapacity(sql, false));
      const available = remaining(row);
      return reply({
        state:
          writes() &&
          available !== null &&
          available > 0 &&
          Number(row?.verification_remaining ?? 0) > 0 &&
          Number(row?.upload_remaining ?? 0) > 0
            ? "available"
            : "held",
        capacity: row ? Number(row.capacity) : null,
        measuredUsed: row ? Number(row.measured_used) : null,
        estimatedUsed: row
          ? Number(row.measured_used) + Number(row.committed)
          : null,
        available: available === null ? null : Math.max(0, available),
        reserved: Number(row?.reserved ?? 0),
        verifiedAt: row?.observed_at.toISOString() ?? null,
      });
    }
    const rowAt = async (sql: Sql, id: string, lock = false) => {
      const { rows } = await sql.query<FileRow>(
        `SELECT * FROM ${files} WHERE id=$1 AND owner_id=$2 AND location=$3 ${lock ? "FOR UPDATE" : ""}`,
        [id, owner, storage.location],
      );
      const file = rows[0];
      if (
        !file ||
        file.provider !== "blomp" ||
        !file.object_key.startsWith(`axfluxo/${file.role}/${owner}/`)
      )
        throw new ApiError(404, "NOT_FOUND");
      return file;
    };
    const ref = (file: FileRow) => ({
      provider: file.provider,
      location: file.location,
      key: file.object_key,
    });
    if (path === "/storage/blomp/files" && !post) {
      const cursor = z.uuid().nullable().parse(url.searchParams.get("cursor"));
      const { rows } = await scoped((sql) =>
        sql.query<FileRow>(
          `SELECT * FROM ${files} WHERE owner_id=$1 AND location=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 51`,
          [owner, storage.location, cursor],
        ),
      );
      return reply({
        files: rows.slice(0, 50).map(view),
        cursor: rows.length > 50 ? rows[49].id : null,
      });
    }
    if (path === "/storage/blomp/files" && post) {
      if (!writes()) throw held();
      const input = blompStart.parse(await jsonBody(request, 4096));
      const key = z.uuid().parse(request.headers.get("idempotency-key"));
      return scoped(async (sql) => {
        const quota = await loadCapacity(sql, true);
        const { rows } = await sql.query<FileRow>(
          `SELECT * FROM ${files} WHERE owner_id=$1 AND request_key=$2`,
          [owner, key],
        );
        if (rows[0]) {
          const existing = view(rows[0]);
          if (
            rows[0].location !== storage.location ||
            Object.entries(input).some(
              ([field, value]) =>
                existing[field as keyof typeof existing] !== value,
            )
          )
            throw unauthorized();
          return reply(existing);
        }
        const duplicate = await sql.query<FileRow>(
          `SELECT * FROM ${files}
          WHERE location=$1 AND owner_id=$2 AND role=$3 AND name=$4 AND mime=$5 AND size=$6 AND sha256=$7
          AND project_id IS NOT DISTINCT FROM $8::uuid AND job_id IS NOT DISTINCT FROM $9::uuid
          AND status<>'cancelled' ORDER BY created_at DESC LIMIT 1`,
          [
            storage.location,
            owner,
            input.role,
            input.name,
            input.mime,
            input.size,
            input.sha256,
            input.projectId,
            input.jobId,
          ],
        );
        if (duplicate.rows[0]) return reply(view(duplicate.rows[0]));
        if (
          (remaining(quota) ?? -1) < input.size ||
          Number(quota?.verification_remaining ?? 0) < input.size ||
          Number(quota?.upload_remaining ?? 0) < input.size
        )
          throw held();
        if (
          (input.projectId &&
            !(
              await sql.query(
                "SELECT id FROM axfluxo_video.video_projects WHERE id=$1 AND owner_id=$2",
                [input.projectId, owner],
              )
            ).rows.length) ||
          (input.jobId &&
            !(
              await sql.query(
                "SELECT id FROM axfluxo_video.render_jobs WHERE id=$1 AND owner_id=$2",
                [input.jobId, owner],
              )
            ).rows.length)
        )
          throw new ApiError(404, "NOT_FOUND");
        const id = randomUUID();
        const object = storage.newReference(input.role, owner);
        const added = await sql.query<FileRow>(
          `INSERT INTO ${files}
          (id,owner_id,location,object_key,role,name,mime,size,sha256,project_id,job_id,request_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            id,
            owner,
            storage.location,
            object.key,
            input.role,
            input.name,
            input.mime,
            input.size,
            input.sha256,
            input.projectId,
            input.jobId,
            key,
          ],
        );
        await sql.query(
          `UPDATE ${capacity} SET reserved=reserved+$2 WHERE location=$1`,
          [storage.location, input.size],
        );
        return reply(view(added.rows[0]), 201);
      });
    }
    const match =
      /^\/storage\/blomp\/files\/([^/]+)(?:\/(resume|part|complete|cancel|download|pause))?$/.exec(
        path,
      );
    if (!match) throw new ApiError(404, "NOT_FOUND");
    const id = z.uuid().parse(match[1]);
    const action = match[2];
    if (!post && !action)
      return reply(view(await scoped((sql) => rowAt(sql, id))));
    if (!post || !action) throw new ApiError(404, "NOT_FOUND");
    const body = await jsonBody(request, 4096);
    const number =
      action === "part"
        ? z
            .strictObject({ number: z.number().int().min(1).max(10000) })
            .parse(body).number
        : (empty.parse(body), 0);
    const freshIdentity = async () => {
      if (
        (await verify(request.headers.get("authorization"))).ownerId !== owner
      )
        throw new ApiError(403, "FILE_ACCESS_DENIED");
    };
    if (action === "download" || action === "part") {
      if (action === "part" && !writes()) throw held();
      const initial = await scoped(async (sql) => {
        const file = await rowAt(sql, id, true);
        if (action === "download") {
          if (file.status !== "ready") throw unauthorized();
        } else {
          if ((remaining(await loadCapacity(sql, false)) ?? -1) < 0)
            throw held();
          if (
            file.status !== "uploading" ||
            !file.upload_id ||
            +file.expires_at <= Date.now() ||
            (file.lease_until && +file.lease_until > Date.now())
          )
            throw unauthorized();
        }
        return file;
      });
      const size = partLength(Number(initial.size), number);
      if (action === "part" && !size)
        throw new ApiError(400, "VALIDATION_FAILED");
      const signed =
        action === "download"
          ? await storage.sign(ref(initial), "GET")
          : await storage.sign(ref(initial), "PART", {
              id: initial.upload_id!,
              number,
              size,
            });
      await freshIdentity();
      await scoped(async (sql) => {
        const latest = await rowAt(sql, id, true);
        if (
          latest.status !== initial.status ||
          latest.upload_id !== initial.upload_id ||
          latest.lease !== initial.lease ||
          (action === "part" &&
            (!writes() ||
              +latest.expires_at <= Date.now() ||
              (remaining(await loadCapacity(sql, false)) ?? -1) < 0))
        )
          throw unauthorized();
        const quota = await loadCapacity(sql, true);
        const budget =
          action === "part" ? "upload_remaining" : "download_remaining";
        const charge = action === "part" ? size : Number(initial.size);
        if (remaining(quota) === null || Number(quota[budget]) < charge)
          throw held();
        await sql.query(
          `UPDATE ${capacity} SET ${budget}=${budget}-$2 WHERE location=$1`,
          [storage.location, charge],
        );
        if (action === "part") {
          if ((remaining(quota) ?? -1) < 0) throw held();
          await sql.query(
            `UPDATE ${files} SET signed_until=greatest(signed_until,$2::timestamptz) WHERE id=$1`,
            [id, new Date(signed.expiresAt + 120000)],
          );
        }
      });
      return reply(signed);
    }
    if (!writes() && action !== "cancel") throw held();
    if (action === "pause") {
      return scoped(async (sql) => {
        const file = await rowAt(sql, id, true);
        if (file.status === "interrupted") return reply(view(file));
        if (
          file.status !== "uploading" ||
          (file.lease_until && +file.lease_until > Date.now())
        )
          throw unauthorized();
        const { rows } = await sql.query<FileRow>(
          `UPDATE ${files} SET status='interrupted',updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
          [id],
        );
        return reply(view(rows[0]));
      });
    }
    const token = randomUUID();
    const initial = await scoped(async (sql) => {
      const file = await rowAt(sql, id, true);
      if (
        (file.status === "ready" && action === "complete") ||
        (file.status === "cancelled" && action === "cancel")
      )
        return file;
      if (file.lease_until && +file.lease_until > Date.now())
        throw unauthorized();
      if (
        action === "cancel" &&
        file.signed_until &&
        +file.signed_until > Date.now()
      )
        throw unauthorized();
      const allowed =
        action === "resume"
          ? ["queued", "creating", "uploading", "interrupted"]
          : action === "complete"
            ? ["uploading", "completing", "verifying"]
            : ["queued", "creating", "uploading", "interrupted", "aborting"];
      if (!allowed.includes(file.status)) throw unauthorized();
      if (
        action === "resume" &&
        (+file.expires_at <= Date.now() ||
          (remaining(await loadCapacity(sql, false)) ?? -1) < 0)
      )
        throw held();
      const state =
        action === "cancel"
          ? "aborting"
          : action === "complete"
            ? "completing"
            : file.status === "queued"
              ? "creating"
              : file.status;
      await sql.query(
        `UPDATE ${files} SET status=$2,lease=$3,lease_until=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE id=$1`,
        [id, state, token],
      );
      return file;
    });
    if (initial.status === "ready" || initial.status === "cancelled")
      return reply(view(initial));
    const object = ref(initial);
    const deadline = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(75000),
    ]);
    const finish = (status: FileRow["status"], uploadId = initial.upload_id) =>
      scoped(async (sql) => {
        const current = await rowAt(sql, id, true);
        if (current.lease !== token) throw unauthorized();
        if (status === "ready" || status === "cancelled")
          await sql.query(
            `UPDATE ${capacity} SET reserved=reserved-$2,committed=committed+$3 WHERE location=$1`,
            [
              storage.location,
              initial.size,
              status === "ready" ? initial.size : 0,
            ],
          );
        const result = await sql.query<FileRow>(
          `UPDATE ${files} SET status=$2,upload_id=$3,lease=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
          [id, status, uploadId],
        );
        return view(result.rows[0]);
      });
    try {
      if (action === "resume") {
        const found =
          initial.status === "creating"
            ? await storage.findUploads(object, deadline)
            : [];
        if (initial.status === "creating" && found.length !== 1)
          throw unauthorized();
        const upload =
          initial.upload_id ??
          found[0] ??
          (await storage.create(object, deadline));
        const parts = await storage.parts(object, upload, deadline);
        await freshIdentity();
        return reply({
          file: await finish("uploading", upload),
          parts: parts
            .filter(
              (part) =>
                Number.isInteger(part.number) &&
                part.number > 0 &&
                partLength(Number(initial.size), part.number) === part.size,
            )
            .map(({ number, size }) => ({ number, size })),
        });
      }
      if (action === "cancel") {
        const found =
          initial.status === "queued"
            ? []
            : await storage.findUploads(object, deadline);
        if (
          found.length > 1 ||
          (found.length === 1 &&
            initial.upload_id &&
            found[0] !== initial.upload_id)
        )
          throw unauthorized();
        if (found[0]) await storage.abort(object, found[0], deadline);
        if (
          initial.status !== "queued" &&
          ((await storage.findUploads(object, deadline)).length ||
            (await storage.head(object, deadline)))
        )
          throw unauthorized();
        return reply(await finish("cancelled"));
      }
      const size = Number(initial.size);
      await scoped(async (sql) => {
        const quota = await loadCapacity(sql, false);
        if (
          (remaining(quota) ?? -1) < 0 ||
          Number(quota.verification_remaining) < size
        )
          throw held();
      });
      let head = await storage.head(object, deadline);
      if (!head) {
        if (!initial.upload_id || initial.status === "verifying")
          throw unauthorized();
        if (initial.status === "completing") {
          const found = await storage.findUploads(object, deadline);
          if (found.length !== 1 || found[0] !== initial.upload_id)
            throw unauthorized();
        }
        const parts = (
          await storage.parts(object, initial.upload_id, deadline)
        ).sort((a, b) => a.number - b.number);
        if (
          parts.length !== Math.ceil(size / partLength(size, 1)) ||
          parts.some(
            (part, index) =>
              part.number !== index + 1 ||
              part.size !== partLength(size, part.number),
          )
        ) {
          await finish("uploading");
          throw unauthorized();
        }
        await storage.complete(object, initial.upload_id, parts, deadline);
        head = await storage.head(object, deadline);
        if (!head) throw unauthorized();
      }
      if (head.size !== size) return reply(await finish("failed"));
      await scoped(async (sql) => {
        const file = await rowAt(sql, id, true);
        const quota = await loadCapacity(sql, true);
        if (
          file.lease !== token ||
          (remaining(quota) ?? -1) < 0 ||
          Number(quota.verification_remaining) < size
        )
          throw held();
        await sql.query(
          `UPDATE ${capacity} SET verification_remaining=verification_remaining-$2 WHERE location=$1`,
          [storage.location, size],
        );
        await sql.query(`UPDATE ${files} SET status='verifying' WHERE id=$1`, [
          id,
        ]);
      });
      const hash = createHash("sha256");
      let total = 0;
      for await (const chunk of await storage.stream(
        object,
        undefined,
        AbortSignal.any([deadline, AbortSignal.timeout(30000)]),
      )) {
        total += chunk.byteLength;
        if (total > size) break;
        hash.update(chunk);
      }
      await freshIdentity();
      return reply(
        await finish(
          total === size && hash.digest("hex") === initial.sha256
            ? "ready"
            : "failed",
        ),
      );
    } catch (error) {
      await scoped((sql) =>
        sql.query(
          `UPDATE ${files} SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2`,
          [id, token],
        ),
      );
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "BLOMP_OPERATION_UNCONFIRMED");
    }
  };
}
