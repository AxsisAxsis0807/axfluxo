import { z } from "zod";
import { authClient } from "../auth";
const entitlementSchema = z.strictObject({
  ownerId: z.uuid(),
  membership: z.literal("developer"),
  validUntil: z.iso.datetime({ offset: true }),
});
export type DeveloperEntitlement = z.infer<typeof entitlementSchema>;
export async function verifyDeveloperAccess(): Promise<DeveloperEntitlement> {
  const client = authClient();
  if (!client) throw Error("ログイン設定を確認してください。");
  const { data: session, error: sessionError } = await client.auth.getSession();
  if (sessionError || !session.session) throw Error("ログインしてください。");
  const result = await client.rpc("axfluxo_developer_access");
  if (result.error) {
    if (["PGRST202", "42883"].includes(result.error.code))
      throw Error(
        "開発者権限の確認機能が未設定です。管理者によるSupabaseの設定が必要です。",
      );
    throw Error(
      "開発者権限を確認できません。ログインと接続を確認してください。",
    );
  }
  const parsed = entitlementSchema.safeParse(result.data);
  if (
    !parsed.success ||
    parsed.data.ownerId !== session.session.user.id ||
    Date.parse(parsed.data.validUntil) <= Date.now()
  )
    throw Error(
      "開発者権限を確認できません。管理者による開発者登録が必要です。",
    );
  return parsed.data;
}
