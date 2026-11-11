import { z } from "zod";
import {
  exportBlobViewSchema,
  exportErrorSchema,
  exportJobRequestSchema,
  exportJobViewSchema,
  exportLimits,
  exportSessionViewSchema,
  type ExportBlobView,
  type ExportJobRequest,
  type ExportJobView,
  type ExportSessionView,
} from "../../domain/cloud-export/schema";
import type { VideoSessionSource } from "./api-client";

export type CloudExportFailure = {
  ok: false;
  reason: "session" | "auth-expired" | "forbidden" | "unavailable" | "failed";
  code: string;
};
export type CloudExportResult<T> = { ok: true; data: T } | CloudExportFailure;

type Session = {
  access_token: string;
  expires_at?: number;
  user?: { id: string };
};

class SessionFailure extends Error {
  constructor(readonly expired: boolean) {
    super("session");
  }
}

export async function sha256Hex(data: ArrayBuffer) {
  if (!globalThis.crypto?.subtle)
    throw new Error("このSafariでは安全な検証を利用できません。");
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Minimal cloud export client. The API origin is public configuration; the access
 * token comes from the existing Supabase session and is never persisted here.
 */
export function createCloudExportClient(options: {
  baseUrl: string;
  session: VideoSessionSource;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const url = new URL(options.baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new Error("Invalid video API origin");
  const transport = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let refreshing: Promise<Session> | null = null;
  function refresh(): Promise<Session> {
    if (!refreshing)
      refreshing = (async () => {
        const result = await options.session.refreshSession();
        if (
          result.error ||
          !result.data.session?.access_token ||
          !result.data.session.expires_at ||
          result.data.session.expires_at * 1000 <= now()
        )
          throw new SessionFailure(true);
        return result.data.session;
      })().finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  async function token(force = false, rejected?: string): Promise<string> {
    let result;
    try {
      result = await options.session.getSession();
    } catch {
      throw new SessionFailure(true);
    }
    if (result.error) throw new SessionFailure(true);
    const session = result.data.session;
    if (!session) throw new SessionFailure(force);
    if (
      !session.access_token ||
      !session.expires_at ||
      session.expires_at * 1000 <= now() + 30000 ||
      (force && session.access_token === rejected)
    )
      return (await refresh()).access_token;
    return session.access_token;
  }
  const failure = (
    status: number,
    code?: string,
  ): CloudExportFailure => ({
    ok: false,
    reason:
      status === 401
        ? "auth-expired"
        : status === 403
          ? "forbidden"
          : status === 503 || status === 429
            ? "unavailable"
            : "failed",
    code: code ?? `HTTP_${status}`,
  });
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    method: "GET" | "POST" = "GET",
    body?: unknown,
    key?: string,
  ): Promise<CloudExportResult<T>> {
    try {
      let accessToken = await token();
      const send = () =>
        transport(new URL(path, url.origin), {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(body === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Idempotency-Key": key!,
                }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
        });
      let response = await send();
      if (response.status === 401) {
        accessToken = await token(true, accessToken);
        response = await send();
      }
      if (!response.ok) {
        let code: string | undefined;
        try {
          const parsed = exportErrorSchema.safeParse(await response.json());
          if (parsed.success) code = parsed.data.error.code;
        } catch {
          /* Raw bodies stay private. */
        }
        return failure(response.status, code);
      }
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success)
        return { ok: false, reason: "failed", code: "INVALID_RESPONSE" };
      return { ok: true, data: parsed.data };
    } catch (error) {
      if (error instanceof SessionFailure)
        return {
          ok: false,
          reason: error.expired ? "auth-expired" : "session",
          code: error.expired ? "AUTH_EXPIRED" : "AUTH_REQUIRED",
        };
      return { ok: false, reason: "failed", code: "REQUEST_FAILED" };
    }
  }
  function upload(
    file: File,
    kind: "video" | "image",
    options2: {
      onProgress?: (fraction: number) => void;
      onHashing?: () => void;
      signal?: AbortSignal;
      sha256?: string;
    } = {},
  ): Promise<CloudExportResult<ExportBlobView>> {
    return (async () => {
      try {
        const accessToken = await token();
        options2.onHashing?.();
        const sha256 =
          options2.sha256 ?? (await sha256Hex(await file.arrayBuffer()));
        const body = await new Promise<CloudExportResult<ExportBlobView>>(
          (resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", new URL("/v1/cloud-export/blobs", url.origin));
            xhr.responseType = "text";
            xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
            xhr.setRequestHeader("x-blob-kind", kind);
            xhr.setRequestHeader("x-content-sha256", sha256);
            xhr.upload.onprogress = (event) => {
              if (event.lengthComputable && event.total > 0)
                options2.onProgress?.(event.loaded / event.total);
            };
            xhr.onerror = () =>
              resolve({
                ok: false,
                reason: "failed",
                code: "NETWORK_FAILED",
              });
            xhr.onabort = () =>
              resolve({ ok: false, reason: "failed", code: "CANCELLED" });
            xhr.onload = () => {
              let code: string | undefined,
                blob: ExportBlobView | undefined;
              try {
                const parsed = z
                  .strictObject({ blob: exportBlobViewSchema })
                  .safeParse(JSON.parse(xhr.responseText));
                if (parsed.success) blob = parsed.data.blob;
              } catch {
                /* ignore malformed bodies */
              }
              if (!blob) {
                try {
                  const parsed = exportErrorSchema.safeParse(
                    JSON.parse(xhr.responseText),
                  );
                  if (parsed.success) code = parsed.data.error.code;
                } catch {
                  /* ignore */
                }
              }
              resolve(
                blob
                  ? { ok: true, data: blob }
                  : failure(xhr.status, code),
              );
            };
            options2.signal?.addEventListener("abort", () => xhr.abort(), {
              once: true,
            });
            xhr.send(file);
          },
        );
        return body;
      } catch (error) {
        if (error instanceof SessionFailure)
          return {
            ok: false,
            reason: error.expired ? "auth-expired" : "session",
            code: error.expired ? "AUTH_EXPIRED" : "AUTH_REQUIRED",
          };
        return { ok: false, reason: "failed", code: "UPLOAD_FAILED" };
      }
    })();
  }
  return {
    session: () =>
      request("/v1/cloud-export/session", exportSessionViewSchema),
    upload,
    createJob: (input: ExportJobRequest, key: string) => {
      const parsed = exportJobRequestSchema.safeParse(input);
      return parsed.success
        ? request(
            "/v1/cloud-export/jobs",
            exportJobViewSchema,
            "POST",
            parsed.data,
            key,
          )
        : Promise.resolve<CloudExportResult<ExportJobView>>({
            ok: false,
            reason: "failed",
            code: "INVALID_REQUEST",
          });
    },
    getJob: (id: string) =>
      request(
        `/v1/cloud-export/jobs/${encodeURIComponent(id)}`,
        exportJobViewSchema,
      ),
    cancelJob: (id: string) =>
      request(
        `/v1/cloud-export/jobs/${encodeURIComponent(id)}/cancel`,
        exportJobViewSchema,
        "POST",
        {},
        `cancel-${id}`,
      ),
    /** Full authenticated download. Range support is exercised by the API tests. */
    download: async (
      id: string,
      onProgress?: (fraction: number) => void,
    ): Promise<CloudExportResult<Blob>> => {
      try {
        let accessToken = await token();
        const send = () =>
          transport(
            new URL(
              `/v1/cloud-export/jobs/${encodeURIComponent(id)}/output`,
              url.origin,
            ),
            {
              headers: { Authorization: `Bearer ${accessToken}` },
              credentials: "omit",
              cache: "no-store",
              redirect: "error",
            },
          );
        let response = await send();
        if (response.status === 401) {
          accessToken = await token(true, accessToken);
          response = await send();
        }
        if (!response.ok)
          return failure(response.status);
        const total = Number(response.headers.get("content-length") ?? 0);
        if (!response.body) return failure(response.status);
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > exportLimits.maxOutputBytes) {
            await reader.cancel();
            return { ok: false, reason: "failed", code: "OUTPUT_TOO_LARGE" };
          }
          chunks.push(value);
          if (total > 0) onProgress?.(received / total);
        }
        if (total > 0 && received !== total)
          return { ok: false, reason: "failed", code: "DOWNLOAD_INCOMPLETE" };
        return {
          ok: true,
          data: new Blob(chunks as BlobPart[], { type: "video/mp4" }),
        };
      } catch (error) {
        if (error instanceof SessionFailure)
          return {
            ok: false,
            reason: error.expired ? "auth-expired" : "session",
            code: error.expired ? "AUTH_EXPIRED" : "AUTH_REQUIRED",
          };
        return { ok: false, reason: "failed", code: "DOWNLOAD_FAILED" };
      }
    },
  };
}

export type CloudExportClient = ReturnType<typeof createCloudExportClient>;
export type { ExportSessionView };
