import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function publicAuthConfig(url?: string, key?: string) {
  if (!url || !key?.startsWith("sb_publishable_") || key.length < 30)
    return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname.endsWith(".supabase.co") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      return null;
    return { url: parsed.origin, key };
  } catch {
    return null;
  }
}
let client: SupabaseClient | null = null;
export function authClient() {
  if (typeof window === "undefined") return null;
  const config = publicAuthConfig(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
  if (!config) return null;
  client ??= createClient(config.url, config.key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: "axfluxo-auth",
    },
  });
  return client;
}
export function authRedirect() {
  return `${window.location.origin}${process.env.NEXT_PUBLIC_BASE_PATH || ""}/`;
}
export function authError(code?: string) {
  switch (code) {
    case "invalid_credentials":
      return "メールアドレスまたはパスワードを確認してください。";
    case "email_not_confirmed":
      return "確認メールのリンクを開いてからログインしてください。";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "送信回数の上限です。しばらく待ってからお試しください。";
    case "weak_password":
      return "より強いパスワードを設定してください。";
    default:
      return "認証を完了できませんでした。通信状況や入力内容を確認し、もう一度お試しください。";
  }
}
