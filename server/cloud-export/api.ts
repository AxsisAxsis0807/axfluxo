import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { Database } from "../db/database";
import { ApiError } from "../api/errors";
import { digest } from "../api/jobs";
import {
  exportErrorSchema,
  exportJobRequestSchema,
  exportJobViewSchema,
  exportSessionViewSchema,
  exportLimits,
  exportOutputName,
  EXPORT_PROFILE,
  type ExportBlobView,
} from "../../src/domain/cloud-export/schema";
import {
  exportApiConfiguration,
  type ExportApiConfig,
} from "./config";
import {
  finalizeBlob,
  discardBlob,
  appendBlobChunk,
  beginBlob,
  blobLayout,
  readBlob,
  requireExportMembership,
  exportScoped,
  type BlobRow,
} from "./storage";
import {
  cancelJob,
  createDownloadTicket,
  createJob,
  getJob,
  outputBlob,
  purgeJob,
  redeemDownloadTicket,
} from "./queue";
import type { TransferPolicy } from "../api/http";

const uuidSchema = z.uuid();
const hashHeader = z.string().regex(/^[a-f0-9]{64}$/);

function headersFor(origin: string | null) {
  const headers = new Headers({
    "cache-control": "no-store",
    vary: "Origin",
    "x-content-type-options": "nosniff",
  });
  if (origin) headers.set("access-control-allow-origin", origin);
  return headers;
}

function json(
  origin: string | null,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) {
  const headers = headersFor(origin);
  headers.set("content-type", "application/json");
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(JSON.stringify(body), { status, headers });
}

async function readJson(request: Request, limit: number) {
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  )
    throw new ApiError(415, "JSON_REQUIRED");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "EXPORT_INPUT_UNSUPPORTED");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ApiError(413, "EXPORT_LIMIT_EXCEEDED");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } catch {
    throw new ApiError(400, "EXPORT_INPUT_UNSUPPORTED");
  }
}

function idempotencyKey(request: Request) {
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key))
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
  return key;
}

/** Streams the request body into bounded database chunks; the declared size bounds receipt. */
async function receiveBlob(
  db: Database,
  owner: string,
  request: Request,
  config: ExportApiConfig,
): Promise<{ blob: ExportBlobView; created: boolean }> {
  if (!config.enabled()) throw new ApiError(503, "EXPORT_DISABLED");
  await exportScoped(db, owner, (sql) => requireExportMembership(sql, owner));
  const kind = request.headers.get("x-blob-kind");
  if (kind !== "video" && kind !== "image")
    throw new ApiError(400, "EXPORT_INPUT_UNSUPPORTED");
  const sha = hashHeader.safeParse(
    request.headers.get("x-content-sha256")?.toLowerCase(),
  );
  if (!sha.success) throw new ApiError(400, "EXPORT_HASH_MISMATCH");
  const declared = request.headers.get("content-length");
  if (!declared || !/^\d+$/.test(declared))
    throw new ApiError(411, "EXPORT_LIMIT_EXCEEDED");
  const size = Number(declared);
  const limit =
    kind === "image" ? config.maxImageBytes : config.maxUploadBytes;
  if (!Number.isSafeInteger(size) || size <= 0 || size > limit)
    throw new ApiError(413, "EXPORT_LIMIT_EXCEEDED");
  const id = randomUUID();
  const { duplicate } = await beginBlob(
    db,
    owner,
    { id, kind, size, sha256: sha.data },
    config.maxOwnerBytes,
  );
  if (duplicate) {
    // The client may safely omit the transfer when an identical ready blob exists.
    await request.body?.cancel().catch(() => undefined);
    return { blob: duplicate, created: false };
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "EXPORT_INPUT_UNSUPPORTED");
  const layout = blobLayout(size);
  const hash = createHash("sha256");
  let received = 0,
    ordinal = 0;
  let buffer = Buffer.alloc(0);
  const flush = async (final: boolean) => {
    while (buffer.byteLength >= layout.chunkSize || (final && buffer.byteLength)) {
      const take = buffer.subarray(0, layout.chunkSize);
      buffer = buffer.subarray(take.byteLength);
      await appendBlobChunk(db, owner, id, ordinal++, take);
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > size) {
        await reader.cancel();
        throw new ApiError(413, "EXPORT_LIMIT_EXCEEDED");
      }
      hash.update(value);
      buffer = Buffer.concat([buffer, Buffer.from(value)]);
      await flush(false);
    }
    await flush(true);
    if (received !== size) throw new ApiError(400, "EXPORT_BLOB_INCOMPLETE");
    if (hash.digest("hex") !== sha.data)
      throw new ApiError(422, "EXPORT_HASH_MISMATCH");
    return {
      blob: await finalizeBlob(db, owner, { id, size, sha256: sha.data }),
      created: true,
    };
  } catch (error) {
    await discardBlob(db, owner, id).catch(() => undefined);
    throw error;
  }
}

function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new ApiError(416, "EXPORT_LIMIT_EXCEEDED");
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) throw new ApiError(416, "EXPORT_LIMIT_EXCEEDED");
  let start: number, end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      throw new ApiError(416, "EXPORT_LIMIT_EXCEEDED");
    start = Math.max(0, size - suffix);
    end = size;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Math.min(size, Number(rawEnd) + 1) : size;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end > size ||
    start >= end
  )
    throw new ApiError(416, "EXPORT_LIMIT_EXCEEDED");
  return { start, end };
}

function stream(
  db: Database,
  owner: string,
  row: BlobRow,
  range: { start: number; end: number } | null,
) {
  const iterator = readBlob(db, owner, row, range ?? undefined);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch {
        controller.error(new Error("EXPORT_STREAM_FAILED"));
      }
    },
    async cancel() {
      await iterator.return?.(undefined).catch(() => undefined);
    },
  });
}

export function cloudExportRouter(options: {
  /** Null when the feature is disabled: no export database connection is opened. */
  db: Database | null;
  enabled: () => boolean;
  maxUploadBytes: number;
  maxImageBytes: number;
  maxClips: number;
  maxFrames: number;
  maxOwnerBytes: number;
  retentionHours: number;
  ticketSeconds: number;
}) {
  const session: ReturnType<typeof exportSessionViewSchema.parse> = {
    enabled: options.enabled(),
    maxUploadBytes: options.maxUploadBytes,
    maxOutputBytes: exportLimits.maxOutputBytes,
    maxClips: options.maxClips,
    maxFrames: options.maxFrames,
    maxOwnerBytes: options.maxOwnerBytes,
    retentionHours: options.retentionHours,
    profile: {
      width: EXPORT_PROFILE.width,
      height: EXPORT_PROFILE.height,
      fps: EXPORT_PROFILE.fps,
    },
  };
  return async (
    request: Request,
    owner: string,
  ): Promise<Response | null> => {
    const origin = request.headers.get("origin");
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/v1/cloud-export/")) return null;
    if (
      !options.db ||
      (path !== "/v1/cloud-export/session" && !options.enabled())
    ) {
      if (request.method === "GET" && path === "/v1/cloud-export/session")
        return json(origin, 200, { ...session, enabled: false });
      return json(origin, 503, { error: { code: "EXPORT_DISABLED" } });
    }
    const db = options.db;
    try {
      if (request.method === "GET" && path === "/v1/cloud-export/session") {
        await exportScoped(db, owner, (sql) =>
          requireExportMembership(sql, owner),
        );
        return json(origin, 200, exportSessionViewSchema.parse(session));
      }
      if (request.method === "POST" && path === "/v1/cloud-export/blobs") {
        const result = await receiveBlob(db, owner, request, options);
        return json(origin, result.created ? 201 : 200, {
          blob: result.blob,
        });
      }
      if (request.method === "POST" && path === "/v1/cloud-export/jobs") {
        if (!options.enabled()) throw new ApiError(503, "EXPORT_DISABLED");
        const key = idempotencyKey(request);
        const parsed = exportJobRequestSchema.safeParse(
          await readJson(request, exportLimits.maxBodyBytes),
        );
        if (!parsed.success)
          throw new ApiError(400, "EXPORT_INPUT_UNSUPPORTED");
        const job = await createJob(
          db,
          owner,
          parsed.data,
          key,
          digest({ path, body: parsed.data }),
          { maxFrames: options.maxFrames, maxClips: options.maxClips },
        );
        return json(origin, 202, exportJobViewSchema.parse(job));
      }
      const jobPath =
        /^\/v1\/cloud-export\/jobs\/([0-9a-fA-F-]{36})(\/cancel|\/output|\/download-ticket)?$/.exec(
          path,
        );
      if (!jobPath) throw new ApiError(404, "EXPORT_NOT_FOUND");
      const id = uuidSchema.parse(jobPath[1]);
      const action = jobPath[2];
      if (request.method === "GET" && !action) {
        return json(origin, 200, await getJob(db, owner, id));
      }
      if (request.method === "POST" && action === "/cancel") {
        return json(origin, 200, await cancelJob(db, owner, id));
      }
      if (request.method === "POST" && action === "/download-ticket") {
        return json(
          origin,
          200,
          await createDownloadTicket(db, owner, id, options.ticketSeconds),
        );
      }
      if (request.method === "DELETE" && !action) {
        await purgeJob(db, owner, id);
        return json(origin, 200, { deleted: true });
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        action === "/output"
      ) {
        const row = await outputBlob(db, owner, id);
        const size = Number(row.size);
        const headers = headersFor(origin);
        headers.set("content-type", "video/mp4");
        headers.set("accept-ranges", "bytes");
        headers.set(
          "content-disposition",
          `attachment; filename="${exportOutputName}"`,
        );
        let range: { start: number; end: number } | null = null;
        try {
          range = parseRange(request.headers.get("range"), size);
        } catch (error) {
          headers.set("content-range", `bytes */${size}`);
          if (error instanceof ApiError)
            return new Response(null, { status: 416, headers });
          throw error;
        }
        if (range) {
          headers.set("content-range", `bytes ${range.start}-${range.end - 1}/${size}`);
          headers.set("content-length", String(range.end - range.start));
          return new Response(
            request.method === "HEAD"
              ? null
              : stream(db, owner, row, range),
            { status: 206, headers },
          );
        }
        headers.set("content-length", String(size));
        return new Response(
          request.method === "HEAD" ? null : stream(db, owner, row, null),
          { status: 200, headers },
        );
      }
      throw new ApiError(404, "EXPORT_NOT_FOUND");
    } catch (error) {
      if (error instanceof ApiError) {
        const parsed = exportErrorSchema.safeParse({
          error: { code: error.code },
        });
        return json(
          origin,
          error.status,
          parsed.success
            ? parsed.data
            : { error: { code: "EXPORT_INPUT_UNSUPPORTED" } },
        );
      }
      if (error instanceof z.ZodError)
        return json(origin, 400, {
          error: { code: "EXPORT_INPUT_UNSUPPORTED" },
        });
      // Never expose SQL, paths, tokens or raw exceptions.
      return json(origin, 500, { error: { code: "EXPORT_STORAGE_UNAVAILABLE" } });
    }
  };
}

/**
 * Unauthenticated, single-use download for browser navigation. The token is the
 * authorization, is stored hashed, expires quickly and is consumed on first use.
 */
export function ticketDownload(options: { db: Database | null }) {
  return async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    const match = /^\/v1\/cloud-export\/downloads\/([A-Za-z0-9_-]{43})$/.exec(path);
    if (!match) return null;
    const missing = () => json(null, 404, { error: { code: "EXPORT_NOT_FOUND" } });
    if (request.method !== "GET" && request.method !== "HEAD")
      return missing();
    if (!options.db) return missing();
    try {
      const ticket = await redeemDownloadTicket(options.db, match[1]);
      if (!ticket) return missing();
      await exportScoped(options.db, ticket.owner, (sql) =>
        requireExportMembership(sql, ticket.owner),
      );
      const row = await outputBlob(options.db, ticket.owner, ticket.job);
      const size = Number(row.size);
      const headers = headersFor(null);
      headers.set("content-type", "video/mp4");
      headers.set("accept-ranges", "bytes");
      headers.set(
        "content-disposition",
        `attachment; filename="${exportOutputName}"`,
      );
      let range: { start: number; end: number } | null = null;
      try {
        range = parseRange(request.headers.get("range"), size);
      } catch {
        headers.set("content-range", `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      if (range) {
        headers.set(
          "content-range",
          `bytes ${range.start}-${range.end - 1}/${size}`,
        );
        headers.set("content-length", String(range.end - range.start));
        return new Response(
          request.method === "HEAD"
            ? null
            : stream(options.db, ticket.owner, row, range),
          { status: 206, headers },
        );
      }
      headers.set("content-length", String(size));
      return new Response(
        request.method === "HEAD"
          ? null
          : stream(options.db, ticket.owner, row, null),
        { status: 200, headers },
      );
    } catch {
      // Never expose whether a token existed, expired, was used or belongs to another owner.
      return missing();
    }
  };
}

/** Server-owned transfer policy. Only these routes may receive/send large bodies. */
export function exportPolicyFor(
  incoming: IncomingMessage,
  policies: {
    control: TransferPolicy;
    chunk: TransferPolicy;
    download: TransferPolicy;
  },
  maxUploadBytes: number,
): TransferPolicy {
  const path = new URL(
    incoming.url ?? "/",
    "http://video-api.invalid",
  ).pathname;
  if (incoming.method === "POST" && path === "/v1/cloud-export/blobs")
    return { ...policies.chunk, bodyBytes: maxUploadBytes };
  if (
    (["GET", "HEAD"].includes(incoming.method ?? "") &&
      /^\/v1\/cloud-export\/jobs\/[0-9a-fA-F-]{36}\/output$/.test(path)) ||
    (["GET", "HEAD"].includes(incoming.method ?? "") &&
      /^\/v1\/cloud-export\/downloads\/[A-Za-z0-9_-]{43}$/.test(path))
  )
    return policies.download;
  return policies.control;
}

export function exportRouterConfiguration(
  env: Record<string, string | undefined>,
) {
  return exportApiConfiguration(env);
}
