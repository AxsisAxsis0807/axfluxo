"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  configureLock,
  isUnlocked,
  readVerifier,
  verifyLock,
  SESSION_KEY,
  UNLOCK_MS,
} from "../../services/developer/local-lock";
export default function LocalDeveloperGate({
  children,
}: {
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false),
    [open, setOpen] = useState(false),
    [configured, setConfigured] = useState(false);
  const [passcode, setPasscode] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [show, setShow] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  useEffect(() => {
    const check = () => {
      try {
        const verifier = readVerifier(localStorage);
        setConfigured(Boolean(verifier));
        setOpen(Boolean(verifier) && isUnlocked(sessionStorage));
      } catch (e) {
        setOpen(false);
        setError(
          e instanceof Error
            ? e.message
            : "保存領域を使用できません。Safariのサイト設定を確認してください。",
        );
      }
      setReady(true);
    };
    check();
    const timer = setInterval(check, 1000);
    window.addEventListener("pageshow", check);
    window.addEventListener("storage", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("storage", check);
    };
  }, []);
  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (!configured) {
        if (passcode !== confirmation) throw Error("確認入力が一致しません。");
        await configureLock(passcode, localStorage);
      } else if (!(await verifyLock(passcode, localStorage)))
        throw Error("パスコードが違います。");
      sessionStorage.setItem(SESSION_KEY, String(Date.now() + UNLOCK_MS));
      setPasscode("");
      setConfirmation("");
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Static Pages navigation deliberately remounts the gate after session storage is updated.
      window.location.assign(`${base}/developer/studio/`);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "解除できません。Safariの保存領域とHTTPS接続を確認してください。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="developer-local-gate">
      <style>{`.developer-local-gate{max-width:1100px;margin:auto;padding:12px;overflow-wrap:anywhere}.developer-local-gate input{font-size:16px;max-width:100%;box-sizing:border-box}.developer-local-gate button,.developer-local-gate a,.developer-local-gate input{min-height:44px}.developer-local-gate nav{display:flex;gap:16px;flex-wrap:wrap}.developer-local-gate label{display:block;margin:12px 0}`}</style>
      <nav>
        <a
          href={`${base}/`}
          onClick={() => sessionStorage.removeItem("axfluxo-view")}
        >
          Workflowへ戻る
        </a>
        <a
          href={`${base}/`}
          onClick={() => sessionStorage.setItem("axfluxo-view", "legacy")}
        >
          旧Studioへ戻る
        </a>
        <Link href="/developer/studio/">Developer Studioへ戻る</Link>
      </nav>
      {!ready ? (
        <p role="status">ロック設定を確認しています…</p>
      ) : open ? (
        <>
          <button
            onClick={() => {
              sessionStorage.removeItem(SESSION_KEY);
              window.dispatchEvent(new Event("axfluxo-local-lock-change"));
              setOpen(false);
            }}
          >
            再ロック
          </button>
          {children}
        </>
      ) : (
        <main>
          <h1>Developer Studio 簡易ロック</h1>
          <p>
            このSafari内だけの個人用ロックです。解析・回避が可能で、認証やクラウドのアクセス権限にはなりません。別端末では別途設定が必要です。
          </p>
          <p>
            解除はこのタブで2時間有効です。素材や完成動画は再読み込み・再ロック前に保存してください。
          </p>
          {!configured && (
            <p>
              初回設定：あなた自身でパスコードを設定してください。秘密の値は送信しません。忘れた場合は、このサイトのロック設定を削除して再設定できます。
            </p>
          )}
          <form onSubmit={(e) => void unlock(e)}>
            <label>
              パスコード
              <input
                required
                minLength={configured ? undefined : 8}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete={configured ? "current-password" : "new-password"}
                type={show ? "text" : "password"}
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
              />
            </label>
            {!configured && (
              <label>
                パスコードの確認
                <input
                  required
                  type={show ? "text" : "password"}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </label>
            )}
            <label>
              <input
                type="checkbox"
                checked={show}
                onChange={(e) => setShow(e.target.checked)}
              />
              入力を表示
            </label>
            <button disabled={busy || !ready}>
              {configured ? "ロック解除" : "設定してロック解除"}
            </button>
          </form>
          {error && <p role="alert">{error}</p>}
        </main>
      )}
    </div>
  );
}
