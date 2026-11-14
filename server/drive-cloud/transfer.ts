import { z } from "zod";
import { ApiError } from "../api/errors";
import type { GoogleDrive } from "../google-drive/google";
export const DRIVE_CHUNK = 4 * 1024 * 1024;
export function uploadUrl(value: string) {
  const u = new URL(value);
  if (
    u.origin !== "https://www.googleapis.com" ||
    u.pathname !== "/upload/drive/v3/files" ||
    !u.searchParams.get("upload_id") ||
    u.username ||
    u.password ||
    u.hash
  )
    throw new ApiError(502, "DRIVE_SESSION_INVALID");
  return u.href;
}
export type DriveMeta = {
  id: string;
  size: number;
  version: string;
  revisionId?: string;
  parents: string[];
  trashed: boolean;
  appProperties: Record<string, string>;
};
/** Drive-native operations: no S3 part numbers/ETags/signatures and no public sharing. */
export class DriveTransfer {
  constructor(
    readonly google: GoogleDrive,
    readonly token: () => Promise<string>,
  ) {}
  async metadata(id: string): Promise<DriveMeta> {
    const raw = await (
      await this.google.api(
        await this.token(),
        `drive/v3/files/${encodeURIComponent(id)}?fields=id,size,version,headRevisionId,parents,trashed,appProperties`,
      )
    ).json();
    const r = z
      .object({
        id: z.string(),
        size: z.coerce.number().int().nonnegative(),
        version: z.string(),
        headRevisionId: z.string().optional(),
        parents: z.array(z.string()),
        trashed: z.boolean(),
        appProperties: z.record(z.string(), z.string()),
      })
      .parse(raw);
    return { ...r, revisionId: r.headRevisionId };
  }
  async capacity() {
    const r = await (
      await this.google.api(
        await this.token(),
        "drive/v3/about?fields=storageQuota,user(permissionId)",
      )
    ).json();
    const quota = z
      .object({
        limit: z.coerce.number().int().nonnegative(),
        usage: z.coerce.number().int().nonnegative(),
      })
      .safeParse(r.storageQuota);
    if (!quota.success || quota.data.limit < quota.data.usage)
      throw new ApiError(503, "DRIVE_CAPACITY_UNKNOWN");
    return {
      free: quota.data.limit - quota.data.usage,
      account: z.string().parse(r.user?.permissionId),
    };
  }
  async begin(p: {
    id: string;
    parent: string;
    owner: string;
    size: number;
    hash: string;
    mime: string;
    name: string;
  }) {
    const response = await this.google.api(
      await this.token(),
      // Drive revision downloads require an explicitly retained blob revision.
      // Each Drive Cloud object is immutable and created exactly once.
      "upload/drive/v3/files?uploadType=resumable&fields=id&keepRevisionForever=true",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-upload-content-length": String(p.size),
          "x-upload-content-type": p.mime,
        },
        body: JSON.stringify({
          id: p.id,
          name: p.name,
          parents: [p.parent],
          appProperties: { axfluxoOwner: p.owner, axfluxoSha256: p.hash },
        }),
      },
    );
    return uploadUrl(response.headers.get("location") ?? "");
  }
  async session(
    url: string,
    size: number,
    data?: Uint8Array,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<{ offset: number; complete: boolean; expired: boolean }> {
    const token = await this.token();
    const response = await this.google.send(uploadUrl(url), {
      method: "PUT",
      headers: {
        authorization: "Bearer " + token,
        "content-length": String(data?.length ?? 0),
        "content-range": data
          ? `bytes ${offset}-${offset + data.length - 1}/${size}`
          : `bytes */${size}`,
      },
      body: data ? Buffer.from(data) : undefined,
      signal,
    }, data ? 120_000 : 10_000);
    if (response.status === 404 || response.status === 410)
      return { offset: 0, complete: false, expired: true };
    if (response.ok) return { offset: size, complete: true, expired: false };
    if (response.status === 308) {
      const range = response.headers.get("range");
      if (range && !/^bytes=0-\d+$/.test(range))
        throw new ApiError(502, "DRIVE_OFFSET_INVALID");
      const confirmed = range ? Number(range.slice(8)) + 1 : 0;
      if (
        !Number.isSafeInteger(confirmed) ||
        confirmed < 0 ||
        confirmed >= size
      )
        throw new ApiError(502, "DRIVE_OFFSET_INVALID");
      return { offset: confirmed, complete: false, expired: false };
    }
    if (response.status === 401)
      throw new ApiError(401, "DRIVE_RECONNECT_REQUIRED");
    if (response.status === 429 || response.status >= 500)
      throw new ApiError(503, "DRIVE_RETRY_LATER");
    if (response.status === 403) {
      const body = await response.json().catch(() => null);
      if (
        body?.error?.errors?.some(
          (e: { reason: string }) => e.reason === "storageQuotaExceeded",
        )
      )
        throw new ApiError(507, "DRIVE_QUOTA_EXCEEDED");
      throw new ApiError(403, "DRIVE_PERMISSION_DENIED");
    }
    throw new ApiError(502, "DRIVE_TRANSFER_FAILED");
  }
  async stream(
    id: string,
    signal?: AbortSignal,
    range?: string,
    revisionId?: string,
  ) {
    const token = await this.token();
    signal?.throwIfAborted();
    // Download duration is governed by the caller/lease; only response headers have a 5s deadline.
    const control = new AbortController();
    const abort = () => control.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 5000);
    let r: Response;
    try {
      r = await this.google.transport(
        "https://www.googleapis.com/drive/v3/files/" +
          encodeURIComponent(id) +
          (revisionId ? "/revisions/" + encodeURIComponent(revisionId) : "") +
          "?alt=media",
        {
          headers: {
            authorization: "Bearer " + token,
            ...(range ? { range } : {}),
          },
          signal: control.signal,
          redirect: "error",
        },
      );
    } catch {
      signal?.removeEventListener("abort", abort);
      throw new ApiError(503, "DRIVE_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok || !r.body) {
      signal?.removeEventListener("abort", abort);
      throw new ApiError(
        r.status === 401 ? 401 : 503,
        r.status === 401 ? "DRIVE_RECONNECT_REQUIRED" : "DRIVE_UNAVAILABLE",
      );
    }
    const reader = r.body.getReader();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const total = setTimeout(abort, 900000);
    let closed = false;
    const cancel = async () => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      clearTimeout(total);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      signal?.removeEventListener("abort", abort);
    };
    return {
      response: r,
      cancel,
      body: (async function* () {
        try {
          while (true) {
            signal?.throwIfAborted();
            idle = setTimeout(abort, 60000);
            const part = await reader.read();
            clearTimeout(idle);
            if (part.done) break;
            yield part.value;
          }
        } finally {
          await cancel();
        }
      })(),
    };
  }
}
