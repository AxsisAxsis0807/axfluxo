"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createVideoApiClient,
  currentVideoSessionSource,
} from "../../services/video/api-client";
import {
  cloudClient,
  type CloudClient,
} from "../../services/cloud-library/client";
import {
  cloudErrorMessage,
  listResumes,
  removeResume,
  uploadFile,
  UploadError,
  value,
  type ResumeRecord,
} from "../../services/cloud-library/upload";
import type { CloudAsset, UploadView } from "../../domain/cloud-library/media";
type Folder = {
  id: string;
  parentId: string | null;
  name: string;
  systemKey: string | null;
};
export default function CloudLibrary({
  client: injected,
  onSelect,
}: {
  client?: CloudClient;
  onSelect?: (asset: CloudAsset) => void;
}) {
  const api = useMemo(() => {
    if (injected) return injected;
    const origin = process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN,
      session = origin ? currentVideoSessionSource() : null;
    if (!origin || !session) return null;
    try {
      return cloudClient(createVideoApiClient({ baseUrl: origin, session }));
    } catch {
      return null;
    }
  }, [injected]);
  const [owner, setOwner] = useState<string | null>(null),
    [folder, setFolder] = useState<string | null>(null),
    [crumbs, setCrumbs] = useState<Folder[]>([]),
    [items, setItems] = useState<CloudAsset[]>([]),
    [folders, setFolders] = useState<Folder[]>([]),
    [known, setKnown] = useState<Folder[]>([]),
    [deleted, setDeleted] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [name, setName] = useState(""),
    [target, setTarget] = useState(""),
    [nextAssets, setNextAssets] = useState<string | null>(null),
    [nextFolders, setNextFolders] = useState<string | null>(null),
    [resumes, setResumes] = useState<ResumeRecord[]>([]),
    [status, setStatus] = useState<UploadView | null>(null),
    [access, setAccess] = useState<{ url: string; expiresAt: number } | null>(
      null,
    ),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!access) return;
    const timer = setTimeout(
      () => setAccess(null),
      Math.max(0, access.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [access]);
  const fileInput = useRef<HTMLInputElement>(null),
    selectedResume = useRef<ResumeRecord | undefined>(undefined),
    active = useRef<AbortController | null>(null);
  const fail = useCallback((e: unknown) => {
    const code = e instanceof UploadError ? e.code : "REQUEST_FAILED";
    setError(
      cloudErrorMessage[code] ??
        "操作を完了できませんでした。権限と接続状態を確認してください。",
    );
    if (["AUTH_REQUIRED", "AUTH_EXPIRED", "HTTP_403"].includes(code)) {
      setOwner(null);
      setItems([]);
      setFolders([]);
    }
  }, []);
  useEffect(() => {
    const pause = () => {
      active.current?.abort();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") pause();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pause);
    return () => {
      pause();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pause);
    };
  }, []);
  useEffect(() => {
    let current = true;
    setAccess(null);
    if (!api) return;
    setBusy(true);
    setError("");
    void (async () => {
      try {
        const me = value(await api.me());
        const [f, a] = await Promise.all([
          api.folders(folder),
          api.assets(folder, deleted),
        ]);
        if (!current) return;
        const fs = value(f),
          as = value(a);
        setOwner(me.ownerId);
        setFolders(fs.items);
        setKnown((old) =>
          Array.from(
            new Map([...old, ...fs.items].map((v) => [v.id, v])).values(),
          ),
        );
        setItems(as.items);
        setNextAssets(as.nextCursor);
        setNextFolders(fs.nextCursor);
        setResumes(listResumes(localStorage, me.ownerId));
      } catch (e) {
        if (current) fail(e);
      } finally {
        if (current) setBusy(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [api, folder, deleted, revision, fail]);
  async function run(work: () => Promise<unknown>, refresh = true) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      if (refresh) setRevision((n) => n + 1);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  function refreshResumes() {
    if (owner) setResumes(listResumes(localStorage, owner));
  }
  async function choose(file: File) {
    if (!api || !owner || busy) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setMessage("原本hashを分割読取りで確認しています…");
    try {
      const result = await uploadFile({
        client: api,
        file,
        ownerId: owner,
        folderId: folder,
        storage: localStorage,
        resume: selectedResume.current,
        signal: controller.signal,
        onProgress: (done, total) =>
          setMessage(`part ${done}/${total} を確認しました`),
      });
      setStatus(result);
      if (result.state === "ready") setRevision((n) => n + 1);
      setMessage(
        result.state === "ready"
          ? "原本の検証が完了しました。"
          : "転送済みです。サーバーで原本を検証しています。",
      );
      if (result.error) throw new UploadError(result.error);
    } catch (e) {
      fail(e);
    } finally {
      active.current = null;
      setBusy(false);
      selectedResume.current = undefined;
      refreshResumes();
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function more(kind: "assets" | "folders") {
    if (!api) return;
    await run(async () => {
      if (kind === "assets" && nextAssets) {
        const page = value(await api.assets(folder, deleted, nextAssets));
        setItems((old) => [...old, ...page.items]);
        setNextAssets(page.nextCursor);
      }
      if (kind === "folders" && nextFolders) {
        const page = value(await api.folders(folder, nextFolders));
        setFolders((old) => [...old, ...page.items]);
        setKnown((old) =>
          Array.from(
            new Map([...old, ...page.items].map((v) => [v.id, v])).values(),
          ),
        );
        setNextFolders(page.nextCursor);
      }
    }, false);
  }
  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
      <h1>開発者クラウド素材</h1>
      <p>
        原本を非公開で保存します。既存画像ライブラリーとバックアップは変更しません。
      </p>
      {!api && <p role="status">クラウド素材APIは未設定です。</p>}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {api && (
        <button disabled={busy} onClick={() => setRevision((n) => n + 1)}>
          再確認
        </button>
      )}
      {owner && api && (
        <>
          <nav aria-label="folder">
            <button
              disabled={busy}
              onClick={() => {
                setFolder(null);
                setCrumbs([]);
              }}
            >
              ルート
            </button>
            {crumbs.map((f, i) => (
              <button
                key={f.id}
                disabled={busy}
                onClick={() => {
                  setFolder(f.id);
                  setCrumbs(crumbs.slice(0, i + 1));
                }}
              >
                {f.name}
              </button>
            ))}
          </nav>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                value(await api.createFolder(name, folder));
                setName("");
              });
            }}
          >
            <label>
              新しいfolder名
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={200}
              />
            </label>
            <button disabled={busy}>folderを作成</button>
          </form>
          <label>
            移動先
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">ルート</option>
              {known.map((f) => (
                <option value={f.id} key={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <ul>
            {folders.map((f) => (
              <li key={f.id}>
                <button
                  disabled={busy}
                  onClick={() => {
                    setFolder(f.id);
                    setCrumbs([...crumbs, f]);
                  }}
                >
                  {f.name}
                </button>
                {!f.systemKey && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () =>
                        value(await api.moveFolder(f.id, target || null)),
                      )
                    }
                  >
                    folderを移動：{f.name}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {nextFolders && (
            <button disabled={busy} onClick={() => void more("folders")}>
              folderをさらに表示
            </button>
          )}
          <label>
            <input
              type="checkbox"
              checked={deleted}
              onChange={(e) => setDeleted(e.target.checked)}
            />
            ゴミ箱を表示
          </label>
          <ul>
            {items.map((a) => (
              <li key={a.id}>
                {onSelect && !a.deleted && (
                  <button style={{ minHeight: 44 }} onClick={() => onSelect(a)}>
                    使用：{a.name}
                  </button>
                )}
                <span>
                  {a.name}（{a.mime}・{a.size} bytes）
                </span>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = new FormData(e.currentTarget);
                    void run(async () =>
                      value(await api.rename(a.id, String(form.get("name")))),
                    );
                  }}
                >
                  <label>
                    新しい素材名
                    <input
                      name="name"
                      defaultValue={a.name}
                      maxLength={200}
                      required
                    />
                  </label>
                  <button disabled={busy}>改名：{a.name}</button>
                </form>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      value(await api.moveAsset(a.id, target || null)),
                    )
                  }
                >
                  素材を移動：{a.name}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      value(await api.trash(a.id, !a.deleted)),
                    )
                  }
                >
                  {a.deleted ? "復元" : "ゴミ箱へ"}：{a.name}
                </button>
                {a.kind === "video" &&
                  process.env.NEXT_PUBLIC_VIDEO_PREVIEW_ENABLED === "true" && (
                    <Link
                      href={`/developer/preview/?version=${encodeURIComponent(a.versionId)}`}
                    >
                      動画preview・非破壊trim：{a.name}
                    </Link>
                  )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () =>
                        setAccess(value(await api.access(a.versionId))),
                      false,
                    )
                  }
                >
                  原本accessを準備：{a.name}
                </button>
              </li>
            ))}
          </ul>
          {nextAssets && (
            <button disabled={busy} onClick={() => void more("assets")}>
              素材をさらに表示
            </button>
          )}
          {access && (
            <p>
              <a href={access.url} target="_blank" rel="noreferrer noopener">
                原本を開く（短時間のみ有効）
              </a>
            </p>
          )}
          <p>
            新規転送、再選択後の再開ともpart並列数は2です。背景化すると一時停止します。
          </p>
          <input
            ref={fileInput}
            aria-label="クラウドへ転送する素材"
            type="file"
            accept="video/mp4,video/quicktime,video/webm,audio/wav,audio/mpeg,audio/mp4,audio/ogg,image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void choose(file);
            }}
          />
          <button disabled={!busy} onClick={() => active.current?.abort()}>
            転送を一時停止
          </button>
          <ul>
            {resumes.map((r) => (
              <li key={r.key}>
                {r.input.name}
                <button
                  disabled={busy}
                  onClick={() => {
                    selectedResume.current = r;
                    fileInput.current?.click();
                  }}
                >
                  同じファイルを再選択して再開
                </button>
                {r.id && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const s = value(await api.status(r.id!));
                          setStatus(s);
                          setMessage(`upload状態：${s.state}`);
                          if (s.error) throw new UploadError(s.error);
                          if (s.state === "ready")
                            removeResume(localStorage, r);
                        })
                      }
                    >
                      upload状態を確認
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          value(await api.abort(r.id!));
                          removeResume(localStorage, r);
                        })
                      }
                    >
                      未完了uploadを中止
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {status && <p role="status">upload状態：{status.state}</p>}
        </>
      )}
      <p>
        <Link href="/developer/video/">動画ジョブへ</Link> ·{" "}
        <Link href="/">制作画面へ戻る</Link>
      </p>
    </main>
  );
}
