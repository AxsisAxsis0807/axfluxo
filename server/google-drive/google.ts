import { z } from "zod";
import { ApiError } from "../api/errors";
import { challenge, type DriveConfig } from "./security";
export const scope = "https://www.googleapis.com/auth/drive.file";
export const MAX_BYTES = 262144;
const metadata = z.object({
  id: z.string(),
  mimeType: z.string(),
  trashed: z.boolean().optional(),
  parents: z.array(z.string()).optional(),
  appProperties: z.record(z.string(), z.string()).optional(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});
export class GoogleDrive {
  constructor(
    readonly config: DriveConfig,
    readonly transport: typeof fetch = fetch,
  ) {}
  authorize(state: string, verifier: string) {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.callback,
      response_type: "code",
      scope,
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: challenge(verifier),
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }
  async token(parameters: Record<string, string>) {
    const response = await this.send("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...parameters,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      if (body?.error === "invalid_grant")
        throw new ApiError(401, "DRIVE_RECONNECT_REQUIRED");
      throw new ApiError(502, "DRIVE_OAUTH_FAILED");
    }
    const result = tokenSchema.parse(await response.json());
    if (result.scope && !result.scope.split(" ").includes(scope))
      throw new ApiError(403, "DRIVE_SCOPE_REQUIRED");
    return result;
  }
  async send(url: string, init: RequestInit) {
    try {
      return await this.transport(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new ApiError(503, "DRIVE_UNAVAILABLE");
    }
  }
  async api(token: string, path: string, init: RequestInit = {}) {
    const response = await this.send("https://www.googleapis.com/" + path, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        authorization: "Bearer " + token,
      },
    });
    if (response.ok) return response;
    const body = await response.json().catch(() => null);
    const reasons = (body?.error?.errors ?? []).map(
      (x: { reason?: string }) => x.reason,
    );
    if (response.status === 401)
      throw new ApiError(401, "DRIVE_RECONNECT_REQUIRED");
    if (response.status === 404)
      throw new ApiError(409, "DRIVE_RESOURCE_MISSING");
    if (reasons.includes("storageQuotaExceeded"))
      throw new ApiError(507, "DRIVE_QUOTA_EXCEEDED");
    if (
      response.status === 429 ||
      response.status >= 500 ||
      reasons.includes("rateLimitExceeded") ||
      reasons.includes("userRateLimitExceeded")
    )
      throw new ApiError(503, "DRIVE_RETRY_LATER");
    if (response.status === 403)
      throw new ApiError(403, "DRIVE_PERMISSION_DENIED");
    if (response.status === 409) throw new ApiError(409, "DRIVE_ID_EXISTS");
    throw new ApiError(502, "DRIVE_API_FAILED");
  }
  async account(token: string) {
    const body = await (
      await this.api(token, "drive/v3/about?fields=user(permissionId)")
    ).json();
    return z.string().min(1).parse(body?.user?.permissionId);
  }
  async ids(token: string, count: number) {
    const result = await (
      await this.api(
        token,
        `drive/v3/files/generateIds?count=${count}&space=drive&type=files`,
      )
    ).json();
    return z
      .array(z.string().regex(/^[\w-]+$/))
      .length(count)
      .parse(result.ids);
  }
  async get(token: string, id: string) {
    return metadata.parse(
      await (
        await this.api(
          token,
          `drive/v3/files/${encodeURIComponent(id)}?fields=id,mimeType,trashed,parents,appProperties`,
        )
      ).json(),
    );
  }
  /** Stable, precommitted IDs make retries safe even after a lost create response. */
  async folder(
    token: string,
    id: string,
    name: string,
    parent: string | undefined,
    owner: string,
    role: string,
  ) {
    let file;
    try {
      file = await this.get(token, id);
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.code !== "DRIVE_RESOURCE_MISSING"
      )
        throw error;
      try {
        await this.api(token, "drive/v3/files?fields=id", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id,
            name,
            mimeType: "application/vnd.google-apps.folder",
            ...(parent ? { parents: [parent] } : {}),
            appProperties: { axfluxoOwner: owner, axfluxoRole: role },
          }),
        });
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "DRIVE_ID_EXISTS")
          throw error;
      }
      file = await this.get(token, id);
    }
    if (
      file.trashed ||
      file.mimeType !== "application/vnd.google-apps.folder" ||
      file.appProperties?.axfluxoOwner !== owner ||
      file.appProperties?.axfluxoRole !== role ||
      (parent && !file.parents?.includes(parent))
    )
      throw new ApiError(409, "DRIVE_FOLDER_RECOVERY_REQUIRED");
    return file;
  }
  async upload(
    token: string,
    id: string,
    parent: string,
    data: Uint8Array,
    owner: string,
    hash: string,
  ) {
    const boundary = "axfluxo-" + id;
    const info = {
      id,
      name: "AxFluxo-test-" + id + ".bin",
      parents: [parent],
      appProperties: { axfluxoOwner: owner, axfluxoSha256: hash },
    };
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(info)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    try {
      await this.api(
        token,
        "upload/drive/v3/files?uploadType=multipart&fields=id",
        {
          method: "POST",
          headers: {
            "content-type": `multipart/related; boundary=${boundary}`,
          },
          body,
        },
      );
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "DRIVE_ID_EXISTS")
        throw error;
    }
  }
  async download(token: string, id: string) {
    const response = await this.api(
      token,
      `drive/v3/files/${encodeURIComponent(id)}?alt=media`,
    );
    const reader = response.body?.getReader();
    if (!reader) throw new ApiError(502, "DRIVE_INTEGRITY_FAILED");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new ApiError(502, "DRIVE_INTEGRITY_FAILED");
        }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "DRIVE_UNAVAILABLE");
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
}
