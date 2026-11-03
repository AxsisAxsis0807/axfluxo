"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  outputsSchema,
  type OutputItem,
} from "../../../server/contracts/outputs";
import {
  createVideoApiClient,
  currentVideoSessionSource,
  videoStateMessage,
} from "../../services/video/api-client";
import type { AuthenticatedApi } from "../../services/cloud-library/client";
import {
  validOutputAccess,
  MAX_SHARE_BYTES,
  prepareShare,
  sharePrepared,
} from "../../services/video/output-save";
import DeveloperPwa from "./DeveloperPwa";
import { watchOwner } from "../../services/local-encoding/session";
const signedSchema = z.object({
  url: z.url(),
  expiresAt: z.number(),
  hash: z.string(),
  size: z.number(),
});
export function OutputLibrary({ api: injected }: { api?: AuthenticatedApi }) {
  const enabled =
    Boolean(injected) ||
    process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED === "true";
  const api = useMemo(() => {
    if (injected) return injected;
    if (!enabled) return null;
    const session = currentVideoSessionSource(),
      baseUrl =
        process.env.NEXT_PUBLIC_DEVELOPER_AUTH_API_ORIGIN ??
        process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
    if (!session || !baseUrl) return null;
    try {
      return createVideoApiClient({ session, baseUrl });
    } catch {
      return null;
    }
  }, [injected, enabled]);
  const [authorized, setAuthorized] = useState(false),
    [owner, setOwner] = useState<string | null>(null);
  useEffect(() => {
    if (owner && !injected)
      return watchOwner(owner, () => {
        setAuthorized(false);
        setOwner(null);
      });
  }, [owner, injected]);
  useEffect(() => {
    let live = true;
    setAuthorized(false);
    if (api)
      void api.me().then((r) => {
        if (live) {
          setAuthorized(r.ok);
          setOwner(r.ok ? r.data.ownerId : null);
          if (!r.ok) setStatus(videoStateMessage[r.state]);
        }
      });
    return () => {
      live = false;
    };
  }, [api]);
  const [items, setItems] = useState<OutputItem[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [checked, setChecked] = useState<Record<string, boolean>>({}),
    [file, setFile] = useState<{ id: string; file: File } | null>(null),
    [direct, setDirect] = useState<{
      id: string;
      url: string;
      expiresAt: number;
    } | null>(null);
  const lock = useRef(false),
    keys = useRef(new Map<string, string>());
  const load = useCallback(
    async (next?: string) => {
      if (!api || !authorized) return;
      const result = await api.request(
        `/outputs${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
        outputsSchema,
      );
      if (result.ok) {
        setItems((old) =>
          next ? [...old, ...result.data.items] : result.data.items,
        );
        setCursor(result.data.nextCursor);
      } else setStatus(videoStateMessage[result.state]);
    },
    [api, authorized],
  );
  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("pageshow", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  async function run(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await work();
    } catch {
      setStatus(
        "操作を完了できませんでした。認証と接続を確認し、再試行してください。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function access(item: OutputItem) {
    if (!api) throw Error();
    const r = await api.request(
      `/render-outputs/${item.id}/access`,
      signedSchema,
    );
    if (!r.ok) {
      setStatus(videoStateMessage[r.state]);
      return null;
    }
    if (!validOutputAccess(r.data, item)) throw Error();
    return r.data;
  }
  if (!enabled) return <p>開発者Studioの入口は停止中です。</p>;
  if (!api)
    return (
      <p>
        ログインと開発者APIの設定を確認してください。既存の編集内容は保持されています。
      </p>
    );
  if (!authorized)
    return (
      <p role="status">
        {status ||
          "開発者権限を確認しています。ログインとアクセス権を確認してください。"}
      </p>
    );
  return (
    <main
      className="developer-output-library"
      style={{ maxWidth: 960, margin: "auto", padding: 16 }}
    >
      <style>{`.developer-output-library button,.developer-output-library a{min-height:44px;display:inline-flex;align-items:center;margin:4px;padding:8px}.developer-output-library label{padding-block:8px}.developer-output-library article{overflow-wrap:anywhere}`}</style>
      <h1>開発者Studio・完成動画</h1>
      <p>
        1本ずつMP4を保存してください。共有・ダウンロード開始や共有成功だけでは保存確認になりません。
      </p>
      <nav>
        <a
          href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/developer/all-versions/`}
          target="_blank"
          rel="noopener noreferrer"
        >
          All Versions Video Maker
        </a>
        {" / "}
        <a
          href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/developer/fnf-showcase/`}
          target="_blank"
          rel="noopener noreferrer"
        >
          FNF Showcase
        </a>
      </nav>
      <DeveloperPwa api={api} />
      <button disabled={busy} onClick={() => void run(() => load())}>
        一覧を更新
      </button>
      <p role="status">{status}</p>
      {items.map((item) => (
        <article
          key={item.id}
          style={{ border: "1px solid", padding: 16, marginBlock: 16 }}
        >
          <h2>{item.filename}</h2>
          <p>
            {(item.size / 1024 / 1024).toFixed(1)} MiB · {item.state}
          </p>
          <p>version: {item.versionId}</p>
          {item.unconfirmed30Days && (
            <p role="alert">
              30日以上、保存が未確認です。完成動画は自動削除しません。
            </p>
          )}
          {item.reason && (
            <p>
              {item.reason === "LEGACY_STORAGE_RETAINED"
                ? "旧bucketの完成物は保持しています。削除には別途、安全な移行が必要です。"
                : "参照中のため保持しています。"}
            </p>
          )}
          {item.state !== "deleted" && item.state !== "deleting" && (
            <>
              {item.size <= MAX_SHARE_BYTES && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const s = await access(item);
                      if (!s) return;
                      setFile({
                        id: item.id,
                        file: await prepareShare(
                          s.url,
                          item.size,
                          item.filename,
                        ),
                      });
                      setStatus(
                        "共有の準備ができました。「共有」をタップしてください。",
                      );
                    })
                  }
                >
                  小さいMP4を共有用に準備
                </button>
              )}
              {file?.id === item.id && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (
                        !navigator.share ||
                        !navigator.canShare?.({ files: [file.file] })
                      ) {
                        setStatus(
                          "この端末ではFile共有を使用できません。MP4をFiles経由で保存してください。",
                        );
                        return;
                      }
                      const result = await sharePrepared(
                        file.file,
                        navigator.share.bind(navigator),
                      );
                      setStatus(
                        result === "cancelled"
                          ? "共有をキャンセルしました。保存未確認です。"
                          : "共有先へ渡しました。写真アプリで実際の保存を確認してください。",
                      );
                      setFile(null);
                    })
                  }
                >
                  共有
                </button>
              )}
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const s = await access(item);
                    if (s) {
                      setDirect({
                        id: item.id,
                        url: s.url,
                        expiresAt: s.expiresAt,
                      });
                      setStatus(
                        "MP4リンクを開き、Filesへ保存できます。Filesから共有→ビデオを保存し、写真アプリで確認してください。",
                      );
                    }
                  })
                }
              >
                MP4 / Files用リンクを取得
              </button>
              {direct?.id === item.id && (
                <a
                  href={direct.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={item.filename}
                  onClick={(e) => {
                    if (Date.now() >= direct.expiresAt) {
                      e.preventDefault();
                      setStatus("リンク期限が切れました。再取得してください。");
                    }
                  }}
                >
                  MP4を開く・Filesへ保存
                </a>
              )}
              {item.state === "unconfirmed" && (
                <>
                  <label style={{ display: "block", minHeight: 44 }}>
                    <input
                      type="checkbox"
                      checked={checked[item.id] ?? false}
                      onChange={(e) =>
                        setChecked((old) => ({
                          ...old,
                          [item.id]: e.target.checked,
                        }))
                      }
                    />
                    写真アプリでこのMP4を開いて保存を確認しました
                  </label>
                  <button
                    disabled={busy || !checked[item.id]}
                    onClick={() =>
                      void run(async () => {
                        const key =
                          keys.current.get(item.id) ?? crypto.randomUUID();
                        keys.current.set(item.id, key);
                        const result = await api.request(
                          `/outputs/${item.id}/confirm-saved`,
                          z.object({ outputId: z.uuid(), state: z.string() }),
                          "POST",
                          {
                            versionId: item.versionId,
                            hash: item.hash,
                            photoLibraryChecked: true,
                          },
                          key,
                        );
                        if (!result.ok) {
                          setStatus(videoStateMessage[result.state]);
                          return;
                        }
                        setFile(null);
                        setDirect(null);
                        setStatus(
                          "保存確認を記録しました。削除状態を一覧で確認してください。",
                        );
                        await load();
                      })
                    }
                  >
                    保存確認・サーバーから削除
                  </button>
                </>
              )}
            </>
          )}
        </article>
      ))}
      {cursor && (
        <button disabled={busy} onClick={() => void run(() => load(cursor))}>
          次の完成動画
        </button>
      )}
    </main>
  );
}
export default OutputLibrary;
