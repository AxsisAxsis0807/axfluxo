import { fnfCodes } from "../../domain/video/fnf-showcase";
import { projectCodes } from "../../domain/video/all-versions";
import { z } from "zod";
import { previewCodeSchema } from "../../domain/video/preview";
import { cloudErrorCodes } from "../../domain/cloud-library/media";
import {
  batchViewSchema,
  createBatchSchema,
  developerMeSchema,
  mutationViewSchema,
  type BatchView,
} from "../../../server/contracts/video";
import { authClient } from "../auth";
import type { FnfSnapshot } from "../../domain/video/schema";
export type VideoState =
  | "ready"
  | "unauthenticated"
  | "auth-expired"
  | "forbidden"
  | "waiting"
  | "held"
  | "failed"
  | "running"
  | "succeeded"
  | "cancelled";
export const videoStateMessage: Record<VideoState, string> = {
  ready: "開発者APIに接続しました。",
  unauthenticated: "ログインしてください。",
  "auth-expired":
    "ログインの期限が切れました。再度ログインしてください。端末内の編集データは保持されています。",
  forbidden: "開発者権限を確認できません。",
  waiting: "ジョブは待機中です。",
  held: "受付またはジョブは保留中です。時間をおいて確認してください。",
  failed: "処理に失敗しました。状態を確認してから再試行してください。",
  running: "ジョブを実行中です。",
  succeeded: "ジョブが完了しました。",
  cancelled: "ジョブは取り消されました。",
};
export type ApiResult<T> =
  | { ok: true; state: VideoState; data: T }
  | { ok: false; state: VideoState; code: string };
type Session = {
  access_token: string;
  expires_at?: number;
  user?: { id: string };
};
export interface VideoSessionSource {
  getSession(): Promise<{ data: { session: Session | null }; error: unknown }>;
  refreshSession(): Promise<{
    data: { session: Session | null };
    error: unknown;
  }>;
}
/** Reuses existing Supabase auth/session storage; never stores a second token copy. */
export function currentVideoSessionSource(): VideoSessionSource | null {
  return authClient()?.auth ?? null;
}
export function batchState(batch: BatchView): VideoState {
  const newest = new Map<number, BatchView["jobs"][number]>();
  for (const job of batch.jobs)
    if (
      !newest.has(job.rangeIndex) ||
      newest.get(job.rangeIndex)!.attempt < job.attempt
    )
      newest.set(job.rangeIndex, job);
  const states = Array.from(newest.values(), (job) => job.state);
  if (states.some((s) => s === "failed" || s === "interrupted"))
    return "failed";
  if (states.some((s) => s === "held")) return "held";
  if (states.some((s) => s === "cancel_requested" || s === "queued"))
    return "waiting";
  if (states.some((s) => s === "running")) return "running";
  if (states.length && states.every((s) => s === "succeeded"))
    return "succeeded";
  if (states.length && states.every((s) => s === "cancelled"))
    return "cancelled";
  return "ready";
}
class SessionFailure extends Error {
  constructor(public state: VideoState) {
    super(state);
  }
}
export function createVideoApiClient(options: {
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
        try {
          const result = await options.session.refreshSession();
          if (
            result.error ||
            !result.data.session?.access_token ||
            !result.data.session.expires_at ||
            result.data.session.expires_at * 1000 <= now()
          )
            throw new Error();
          return result.data.session;
        } catch {
          throw new SessionFailure("auth-expired");
        }
      })().finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  async function token(force = false, rejectedToken?: string): Promise<string> {
    let result: Awaited<ReturnType<VideoSessionSource["getSession"]>>;
    try {
      result = await options.session.getSession();
    } catch {
      throw new SessionFailure("auth-expired");
    }
    if (result.error) throw new SessionFailure("auth-expired");
    const session = result.data.session;
    if (!session)
      throw new SessionFailure(force ? "auth-expired" : "unauthenticated");
    if (
      !session.access_token ||
      !session.expires_at ||
      session.expires_at * 1000 <= now() + 30000 ||
      (force && session.access_token === rejectedToken)
    )
      return (await refresh()).access_token;
    return session.access_token;
  }
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    body?: unknown,
    key?: string,
    ifMatch?: string,
    projectOwner?: string,
  ): Promise<ApiResult<T>> {
    try {
      if (method === "POST" && (!key || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key)))
        return { ok: false, state: "failed", code: "IDEMPOTENCY_KEY_REQUIRED" };
      let accessToken = await token();
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      const send = () =>
        transport(new URL(path, url.origin), {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(ifMatch ? { "If-Match": ifMatch } : {}),
            ...(projectOwner ? { "X-Project-Owner": projectOwner } : {}),
            ...(serialized === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Idempotency-Key": key!,
                }),
          },
          body: serialized,
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
        const state: VideoState =
          response.status === 401
            ? "auth-expired"
            : response.status === 403
              ? "forbidden"
              : response.status === 503 || response.status === 429
                ? "held"
                : "failed";
        let safeCode: string | undefined;
        try {
          const parsed = z
            .strictObject({
              error: z.strictObject({
                code: z.enum([
                  ...cloudErrorCodes,
                  ...projectCodes,
                  ...fnfCodes,
                  ...previewCodeSchema.options,
                ]),
              }),
            })
            .safeParse(await response.json());
          if (parsed.success) safeCode = parsed.data.error.code;
        } catch {
          /* Raw errors stay private. */
        }
        // Raw backend bodies can contain secrets if a proxy misbehaves; never expose them to UI/logs.
        return {
          ok: false,
          state,
          code:
            safeCode ??
            (response.status === 409 ? "CONFLICT" : `HTTP_${response.status}`),
        };
      }
      const value = schema.safeParse(await response.json());
      if (!value.success)
        return { ok: false, state: "failed", code: "INVALID_RESPONSE" };
      const state = batchViewSchema.safeParse(value.data);
      const mutation = mutationViewSchema.safeParse(value.data);
      return {
        ok: true,
        state: state.success
          ? batchState(state.data)
          : mutation.success
            ? batchState({
                id: mutation.data.batchId,
                ownerId: mutation.data.batchId,
                jobs: [mutation.data.job],
                outputs: [],
              })
            : "ready",
        data: value.data,
      };
    } catch (error) {
      if (error instanceof SessionFailure)
        return {
          ok: false,
          state: error.state,
          code:
            error.state === "unauthenticated"
              ? "AUTH_REQUIRED"
              : "AUTH_EXPIRED",
        };
      return { ok: false, state: "failed", code: "REQUEST_FAILED" };
    }
  }
  return {
    request,
    me: () => request("/v1/developer/me", developerMeSchema),
    createBatch: (snapshot: FnfSnapshot, key: string) => {
      const parsed = createBatchSchema.safeParse({ snapshot });
      return parsed.success
        ? request("/render-batches", batchViewSchema, "POST", parsed.data, key)
        : Promise.resolve<ApiResult<BatchView>>({
            ok: false,
            state: "failed",
            code: "VALIDATION_FAILED",
          });
    },
    getBatch: (id: string) =>
      request(`/render-batches/${encodeURIComponent(id)}`, batchViewSchema),
    retry: (id: string, key: string) =>
      request(
        `/render-jobs/${encodeURIComponent(id)}/retry`,
        mutationViewSchema,
        "POST",
        {},
        key,
      ),
    cancel: (id: string, key: string) =>
      request(
        `/render-jobs/${encodeURIComponent(id)}/cancel`,
        mutationViewSchema,
        "POST",
        {},
        key,
      ),
  };
}
