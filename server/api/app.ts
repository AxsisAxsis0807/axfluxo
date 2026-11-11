import { z } from "zod";
import { createBatchSchema } from "../contracts/video";
import type { Database } from "../db/database";
import type { VerifyToken } from "./auth";
import { ApiError } from "./errors";
import {
  cancelJob,
  createBatch,
  digest,
  getBatch,
  idempotent,
  requireMembership,
  retryJob,
} from "./jobs";
export interface ApiConfig {
  outputs?: (
    request: Request,
    owner: string,
  ) => Promise<{ status: number; body: unknown }>;
  db: Database;
  verify: VerifyToken;
  allowedOrigins: readonly string[];
  admissionEnabled: () => boolean;
  unitsPerFrame?: number;
  fnf?: (
    request: Request,
    owner: string,
  ) => Promise<{ status: number; body: unknown }>;
  projects?: (
    request: Request,
    owner: string,
  ) => Promise<{ status: number; body: unknown }>;
  render?: (
    request: Request,
    owner: string,
  ) => Promise<{ status: number; body: unknown }>;
  cloud?: (
    request: Request,
    owner: string,
  ) => Promise<{ status: number; body: unknown }>;
  /** Raw response hook for streaming handlers (uploads/storage downloads). */
  response?: (request: Request, owner: string) => Promise<Response | null>;
  /** Pre-authentication hook for single-use token downloads. */
  public?: (request: Request) => Promise<Response | null>;
}
export async function jsonBody(request: Request) {
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  )
    throw new ApiError(415, "JSON_REQUIRED");
  if (
    request.headers.has("content-encoding") &&
    request.headers.get("content-encoding") !== "identity"
  )
    throw new ApiError(415, "JSON_REQUIRED");
  const limit = 1024 * 1024;
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "VALIDATION_FAILED");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(413, "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(joined),
    ) as unknown;
  } catch {
    throw new ApiError(400, "VALIDATION_FAILED");
  }
}
/** Fetch handler deliberately independent of Next routes/static export. Never logs a request. */
export function createVideoApi(
  config: ApiConfig,
): (request: Request) => Promise<Response> {
  const origins = new Set(config.allowedOrigins);
  for (const origin of origins) {
    const url = new URL(origin);
    if (
      origin === "null" ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)
        ))
    )
      throw new Error("Invalid CORS origin configuration");
  }
  if (!origins.size) throw new Error("Explicit CORS origins required");
  return async (request) => {
    const headers = new Headers({
      "cache-control": "no-store",
      vary: "Origin",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      "access-control-expose-headers":
        "Content-Range, Content-Length, Accept-Ranges, Content-Disposition",
    });
    const origin = request.headers.get("origin");
    const respond = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers });
    try {
      if (origin && !origins.has(origin))
        throw new ApiError(403, "ORIGIN_NOT_ALLOWED");
      if (origin) headers.set("access-control-allow-origin", origin);
      if (request.method === "OPTIONS") {
        if (!origin) throw new ApiError(403, "ORIGIN_NOT_ALLOWED");
        const method = request.headers.get("access-control-request-method");
        const requestedHeaders =
          request.headers
            .get("access-control-request-headers")
            ?.toLowerCase()
            .split(",")
            .map((v) => v.trim()) ?? [];
        if (
          !method ||
          !["GET", "HEAD", "POST", "DELETE"].includes(method) ||
          requestedHeaders.some(
            (v) =>
              ![
                "authorization",
                "content-type",
                "idempotency-key",
                "if-match",
                "x-project-owner",
                "range",
              ].includes(v),
          )
        )
          throw new ApiError(403, "ORIGIN_NOT_ALLOWED");
        headers.set(
          "access-control-allow-methods",
          "GET, HEAD, POST, DELETE, OPTIONS",
        );
        headers.set(
          "access-control-allow-headers",
          "Authorization, Content-Type, Idempotency-Key, If-Match, X-Project-Owner, Range",
        );
        headers.delete("content-type");
        return new Response(null, { status: 204, headers });
      }
      // Single-use token downloads authenticate with the token itself.
      if (config.public) {
        const raw = await config.public(request);
        if (raw) return raw;
      }
      const identity = await config.verify(
        request.headers.get("authorization"),
      );
      const path = new URL(request.url).pathname;
      if (config.response) {
        const raw = await config.response(request, identity.ownerId);
        if (raw) return raw;
      }
      if (
        config.outputs &&
        (path === "/outputs" ||
          path.startsWith("/outputs/") ||
          path.startsWith("/push/"))
      ) {
        const result = await config.outputs(request, identity.ownerId);
        return respond(result.status, result.body);
      }
      if (path.startsWith("/cloud/") && config.cloud) {
        const result = await config.cloud(request, identity.ownerId);
        return respond(result.status, result.body);
      }
      if (
        config.render &&
        (path === "/render-all-versions" ||
          /^\/render-jobs\/[^/]+\/progress$/.test(path) ||
          path.startsWith("/render-outputs/"))
      ) {
        const result = await config.render(request, identity.ownerId);
        return respond(result.status, result.body);
      }
      if (config.projects && path.startsWith("/projects/")) {
        const result = await config.projects(request, identity.ownerId);
        return respond(result.status, result.body);
      }
      if (
        config.fnf &&
        (path.startsWith("/fnf-showcase/") || path.startsWith("/preferences/"))
      ) {
        const result = await config.fnf(request, identity.ownerId);
        return respond(result.status, result.body);
      }
      const batchMatch = /^\/render-batches\/([a-fA-F0-9-]+)$/.exec(path);
      const jobMatch = /^\/render-jobs\/([a-fA-F0-9-]+)\/(retry|cancel)$/.exec(
        path,
      );
      const result = await config.db.transaction(async (sql) => {
        await requireMembership(sql, identity.ownerId);
        if (request.method === "GET" && path === "/v1/developer/me")
          return {
            status: 200,
            body: { ownerId: identity.ownerId, membership: "developer" },
          };
        if (request.method === "GET" && batchMatch) {
          const id = z.uuid().parse(batchMatch[1]);
          return {
            status: 200,
            body: await getBatch(sql, identity.ownerId, id),
          };
        }
        if (
          request.method !== "POST" ||
          (path !== "/render-batches" && !jobMatch)
        )
          throw new ApiError(404, "NOT_FOUND");
        const key = request.headers.get("idempotency-key");
        if (!key || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key))
          throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
        const body = await jsonBody(request);
        const parsed =
          path === "/render-batches"
            ? createBatchSchema.parse(body)
            : z.strictObject({}).parse(body);
        const id = jobMatch ? z.uuid().parse(jobMatch[1]) : undefined;
        const hash = digest({ path, body: parsed });
        return idempotent(sql, identity.ownerId, key, hash, async () => {
          if (jobMatch?.[2] !== "cancel" && !config.admissionEnabled())
            throw new ApiError(503, "ADMISSION_CLOSED");
          if ("snapshot" in parsed)
            return {
              status: 202,
              body: await createBatch(
                sql,
                identity.ownerId,
                parsed.snapshot,
                config.unitsPerFrame,
              ),
            };
          if (jobMatch?.[2] === "retry")
            return {
              status: 202,
              body: await retryJob(
                sql,
                identity.ownerId,
                id!,
                config.unitsPerFrame,
              ),
            };
          return {
            status: 202,
            body: await cancelJob(sql, identity.ownerId, id!),
          };
        });
      });
      return respond(result.status, result.body);
    } catch (error) {
      if (error instanceof ApiError)
        return respond(error.status, { error: { code: error.code } });
      if (error instanceof z.ZodError)
        return respond(400, { error: { code: "VALIDATION_FAILED" } });
      // No JWT, SQL detail, filenames, signed URL, database secret or raw exception in response/logs.
      return respond(500, { error: { code: "INTERNAL_ERROR" } });
    }
  };
}
