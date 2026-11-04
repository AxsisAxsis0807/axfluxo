"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  allowExportAudio,
  localExportQueue as queue,
} from "../../services/video/local-export-runtime";
import { isUnlocked, readVerifier } from "../../services/developer/local-lock";
import type { ExportEntry } from "../../services/video/export-queue";
function SavedFile({ entry }: { entry: ExportEntry }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!entry.result) return;
    const value = URL.createObjectURL(entry.result.blob);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [entry.result]);
  return url ? (
    <a href={url} download={entry.filename}>
      {entry.filename}を保存
    </a>
  ) : null;
}
export default function ExportDock() {
  const { entries, paused } = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  );
  const [open, setOpen] = useState(false),
    [unlocked, setUnlocked] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const check = () => {
      let allowed = false;
      try {
        allowed =
          Boolean(readVerifier(localStorage)) && isUnlocked(sessionStorage);
      } catch {
        /* fail closed */
      }
      setUnlocked(allowed);
      if (
        !allowed &&
        queue
          .getSnapshot()
          .entries.some((j) =>
            ["queued", "preparing", "rendering"].includes(j.state),
          )
      )
        queue.pause(true);
    };
    const hidden = () => {
      if (document.hidden) queue.pause(true);
    };
    const leave = (e: BeforeUnloadEvent) => {
      if (queue.getSnapshot().entries.some((e) => e.input || e.result)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    check();
    const timer = setInterval(check, 1000);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("beforeunload", leave);
    window.addEventListener("axfluxo-local-lock-change", check);
    window.addEventListener("storage", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("axfluxo-local-lock-change", check);
      window.removeEventListener("storage", check);
    };
  }, []);
  if (!unlocked || !entries.length) return null;
  const current =
    entries.find((e) => ["preparing", "rendering"].includes(e.state)) ??
    entries.find((e) => e.state === "queued") ??
    entries.at(-1)!;
  const waiting = entries.filter((e) => e.state === "queued").length;
  return (
    <>
      <div className="export-dock-space" />
      <aside aria-label="エクスポートミニバー" className="export-dock">
        <button aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span>
            {current.filename} · {paused ? "一時停止" : current.state} ·{" "}
            {Math.floor(current.progress * 100)}% · 予約待ち {waiting}件
          </span>
          <progress
            aria-label="書き出し進捗"
            max={1}
            value={current.progress}
          />
          <span>{open ? "詳細を閉じる" : "詳細を開く"}</span>
        </button>
      </aside>
      {open && (
        <section
          role="dialog"
          aria-label="エクスポート管理"
          className="export-panel"
        >
          <button onClick={() => setOpen(false)}>詳細を閉じる</button>
          <h2>書き出しキュー</h2>
          <p>
            予約は1件ずつ自動開始します。Safariを前面に保ってください。タブ終了で予約・完成ファイルは失われます。
          </p>
          {(paused || current.message.includes("音声処理")) && (
            <button
              onClick={() => {
                void allowExportAudio()
                  .then(() => {
                    queue.resume();
                    setError("");
                  })
                  .catch((e) => setError(String(e)));
              }}
            >
              音声処理を許可・キューを再開
            </button>
          )}
          {!paused && (
            <button onClick={() => queue.pause()}>
              このジョブの後で一時停止
            </button>
          )}
          {error && <p role="alert">{error}</p>}
          <p role="status">
            {paused
              ? "キューは一時停止中です。保持上限の場合は保存済みファイルを確認して削除してください。"
              : waiting
                ? `${waiting}件の予約待ち`
                : "予約待ちはありません。"}
          </p>
          {entries.map((entry) => (
            <article key={entry.id} aria-label={entry.filename}>
              <strong>{entry.filename}</strong>
              <p>
                {entry.state} · {Math.floor(entry.progress * 100)}% ·{" "}
                {entry.message}
              </p>
              <progress
                max={1}
                value={entry.progress}
                aria-label={`${entry.filename} 進捗`}
              />
              {entry.error && <p role="alert">{entry.error}</p>}
              {["queued", "preparing", "rendering"].includes(entry.state) && (
                <button onClick={() => queue.cancel(entry.id)}>
                  キャンセル
                </button>
              )}
              {entry.state === "queued" && (
                <>
                  <button onClick={() => queue.move(entry.id, -1)}>
                    予約を前へ
                  </button>
                  <button onClick={() => queue.move(entry.id, 1)}>
                    予約を後へ
                  </button>
                </>
              )}
              {entry.state === "failed" && (
                <button
                  onClick={() => {
                    void allowExportAudio().catch((e) => setError(String(e)));
                    queue.retry(entry.id);
                  }}
                >
                  再試行
                </button>
              )}
              {entry.result && <SavedFile entry={entry} />}
              {["completed", "failed", "cancelled"].includes(entry.state) && (
                <button
                  onClick={() => {
                    if (
                      !entry.result ||
                      window.confirm(
                        "保存したファイルを確認しましたか？この完成ファイルを削除すると、このタブから再保存できません。",
                      )
                    )
                      queue.remove(entry.id);
                  }}
                >
                  {entry.result
                    ? "保存確認後に完成ファイルを削除"
                    : "ジョブを削除"}
                </button>
              )}
            </article>
          ))}
          <details>
            <summary>保存方法・保持上限・Safariの制限</summary>
            <p>
              保存リンクからFilesへ保存後、MP4は共有メニューの「ビデオを保存」を選べます。保存完了は検知できません。ファイルを確認してから明示的に削除してください。
            </p>
            <p>
              最大12件・完成ファイル合計512MiB以内（次の1件分256MiBを確保できないと後続処理を一時停止）。画面ロック・バックグラウンドでは中断します。再読み込み・タブ終了による予約と完成ファイルの復元はできません。
            </p>
          </details>
        </section>
      )}
      <style>{`.export-dock-space{height:calc(92px + env(safe-area-inset-bottom))}.export-dock{position:fixed;bottom:0;left:0;right:0;z-index:1000;background:#24202d;border-top:1px solid #a58abe;padding:8px 12px calc(8px + env(safe-area-inset-bottom));color:white}.export-dock>button{width:100%;display:grid;grid-template-columns:minmax(0,1fr);text-align:left;gap:6px;background:transparent;color:inherit;border:0;min-height:52px}.export-dock>button>span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.export-dock progress{width:100%;grid-column:1/-1;height:6px}.export-panel{position:fixed;z-index:1001;right:12px;bottom:calc(92px + env(safe-area-inset-bottom));width:min(620px,calc(100vw - 24px));max-height:65dvh;overflow:auto;overscroll-behavior:contain;box-sizing:border-box;padding:16px;border-radius:16px;background:#24202d;color:white;box-shadow:0 0 24px #0008}.export-panel article{padding:12px 0;border-top:1px solid #746680;overflow-wrap:anywhere}.export-panel button,.export-panel a{display:inline-block;min-height:44px;padding:8px;margin:4px}.export-panel a{color:#d9c3ff}.export-panel progress{width:100%}@media(max-width:600px){.export-panel{right:0;width:100%;border-radius:16px 16px 0 0}}`}</style>
    </>
  );
}
