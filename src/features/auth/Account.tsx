"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { authClient, authError, authRedirect } from "../../services/auth";
type Mode = "login" | "signup" | "reset" | "resend" | "password";
const titles: Record<Mode, string> = {
  login: "ログイン",
  signup: "アカウント登録",
  reset: "パスワード再設定メール",
  resend: "確認メール再送",
  password: "新しいパスワードを保存",
};
export default function Account() {
  const [user, setUser] = useState<User | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const client = authClient();
  useEffect(() => {
    if (!client) {
      setLoading(false);
      return;
    }
    let active = true;
    // Subscribe before getSession: URL recovery may finish during initialization.
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      setUser(session?.user ?? null);
      setLoading(false);
      if (event === "PASSWORD_RECOVERY") {
        setMode("password");
        setOpen(true);
        setMessage("");
      }
    });
    void client.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        setUser(data.session?.user ?? null);
        if (error) {
          setMessage(authError(error.code));
          setOpen(true);
        }
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setLoading(false);
          setMessage(authError());
        }
      });
    const params = new URLSearchParams(window.location.hash.slice(1));
    if (
      params.has("error_description") ||
      new URLSearchParams(window.location.search).has("error")
    ) {
      setMessage(
        "認証リンクが無効または期限切れです。確認メールや再設定メールを再送してください。",
      );
      setOpen(true);
      window.history.replaceState({}, "", authRedirect());
    }
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client]);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current?.close();
  }, [open]);
  function close() {
    if (busy) return;
    setOpen(false);
    setPassword("");
    setMessage("");
    trigger.current?.focus();
  }
  function change(next: Mode) {
    setMode(next);
    setPassword("");
    setMessage("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!client || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const address = email.trim();
      const redirect = authRedirect();
      let error;
      if (mode === "signup")
        ({ error } = await client.auth.signUp({
          email: address,
          password,
          options: { emailRedirectTo: redirect },
        }));
      else if (mode === "login")
        ({ error } = await client.auth.signInWithPassword({
          email: address,
          password,
        }));
      else if (mode === "reset")
        ({ error } = await client.auth.resetPasswordForEmail(address, {
          redirectTo: redirect,
        }));
      else if (mode === "resend")
        ({ error } = await client.auth.resend({
          type: "signup",
          email: address,
          options: { emailRedirectTo: redirect },
        }));
      else ({ error } = await client.auth.updateUser({ password }));
      if (error) setMessage(authError(error.code));
      else {
        setPassword("");
        setMessage(
          mode === "login"
            ? "ログインしました。"
            : mode === "password"
              ? "パスワードを更新しました。"
              : "対象のアドレスにメールを送信しました。受信トレイをご確認ください。",
        );
        if (mode === "password") setMode("login");
      }
    } catch {
      setMessage(authError());
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    if (!client || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) setMessage(authError(error.code));
      else {
        setUser(null);
        setMode("login");
        setPassword("");
        setMessage("ログアウトしました。制作データはこの端末に残っています。");
      }
    } catch {
      setMessage(authError());
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        ref={trigger}
        className="account-trigger"
        disabled={loading}
        onClick={() => setOpen(true)}
      >
        {user ? "アカウント" : "ログイン / 登録"}
      </button>
      <dialog
        ref={dialog}
        className="account-dialog"
        aria-labelledby="account-title"
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <button
          className="account-close"
          aria-label="アカウントを閉じる"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
        <h2 id="account-title">
          {user && mode !== "password" ? "アカウント" : titles[mode]}
        </h2>
        <p>
          制作データはこの端末に保存されます。ログインしてもクラウド同期は行いません。
        </p>
        {!client ? (
          <p>
            メール認証は現在利用できません。ゲストとして引き続き編集できます。
          </p>
        ) : user && mode !== "password" ? (
          <>
            <p>{user.email}</p>
            <button disabled={busy} onClick={() => void logout()}>
              ログアウト
            </button>
          </>
        ) : (
          <>
            <form onSubmit={(event) => void submit(event)}>
              {mode !== "password" && (
                <label>
                  メールアドレス
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                    value={email}
                    disabled={busy}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
              )}
              {(mode === "login" ||
                mode === "signup" ||
                mode === "password") && (
                <label>
                  パスワード
                  <input
                    type="password"
                    autoComplete={
                      mode === "login" ? "current-password" : "new-password"
                    }
                    required
                    minLength={mode === "login" ? 1 : 8}
                    maxLength={128}
                    value={password}
                    disabled={busy}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              )}
              <button className="primary" disabled={busy}>
                {busy ? "処理中…" : titles[mode]}
              </button>
            </form>
            {mode !== "password" && (
              <nav aria-label="認証メニュー">
                {(["login", "signup", "reset", "resend"] as Mode[])
                  .filter((m) => m !== mode)
                  .map((m) => (
                    <button key={m} disabled={busy} onClick={() => change(m)}>
                      {titles[m]}
                    </button>
                  ))}
              </nav>
            )}
          </>
        )}
        {message && (
          <p role="status" aria-live="polite">
            {message}
          </p>
        )}
        <button disabled={busy} onClick={close}>
          {user ? "編集に戻る" : "ゲストとして続ける"}
        </button>
      </dialog>
    </>
  );
}
