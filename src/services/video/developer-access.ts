import type { ApiResult } from "./api-client";
import type { AuthenticatedApi } from "../cloud-library/client";
import {
  developerServicesSchema,
  unavailableDeveloperServices,
} from "../../../server/contracts/developer-services";
export type DeveloperAccessState =
  | "checking"
  | "ready"
  | "disabled"
  | "unconfigured"
  | "unauthenticated"
  | "auth-expired"
  | "forbidden"
  | "unavailable";
export const developerAccessMessages: Record<DeveloperAccessState, string> = {
  checking: "開発者権限をサーバーで確認しています…",
  ready: "開発者権限を確認しました。",
  disabled: "開発者Studioの入口は停止中です。",
  unconfigured: "開発者認可APIは未設定です。管理者による準備が必要です。",
  unauthenticated: "ログインしてください。開発者権限はサーバーで確認します。",
  "auth-expired":
    "認証期限が切れました。再ログインして権限を確認してください。端末の保存データは保持しています。",
  forbidden: "開発者権限がありません。一般アカウントでは利用できません。",
  unavailable: "開発者権限を確認できません。接続を確認し、再試行してください。",
};
export function accessFailure(
  result: Exclude<ApiResult<unknown>, { ok: true }>,
): DeveloperAccessState {
  return result.state === "unauthenticated" ||
    result.state === "auth-expired" ||
    result.state === "forbidden"
    ? result.state
    : "unavailable";
}
export async function checkDeveloper(api: AuthenticatedApi) {
  const result = await api.me();
  if (!result.ok)
    return {
      state: accessFailure(result),
      owner: null,
      services: unavailableDeveloperServices,
    } as const;
  const services = await api.request(
    "/v1/developer/services",
    developerServicesSchema,
  );
  if (
    !services.ok &&
    ["unauthenticated", "auth-expired", "forbidden"].includes(services.state)
  )
    return {
      state: accessFailure(services),
      owner: null,
      services: unavailableDeveloperServices,
    } as const;
  return {
    state: "ready" as const,
    owner: result.data.ownerId,
    services: services.ok ? services.data : unavailableDeveloperServices,
  };
}
