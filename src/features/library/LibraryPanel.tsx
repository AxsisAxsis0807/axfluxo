"use client";
/* eslint-disable @next/next/no-img-element -- revocable local thumbnail URLs */
import { useEffect, useRef, useState } from "react";
import {
  libraryRef,
  type LibraryFile,
  type LibraryFolder,
  type LibraryRef,
} from "../../domain/library";
import {
  importLibraryImage,
  listFiles,
  listFolders,
  putFolder,
  updateFile,
  versionFor,
} from "../../services/library/repository";
import { decodeImage } from "../../services/assets";
let thumbnails = Promise.resolve();
function Thumbnail({ file }: { file: LibraryFile }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let disposed = false,
      owned = "";
    thumbnails = thumbnails
      .catch(() => {})
      .then(async () => {
        if (disposed) return;
        const v = await versionFor(file);
        const image = await decodeImage(v.blob);
        const canvas = document.createElement("canvas");
        try {
          const scale = Math.min(1, 160 / Math.max(v.width, v.height));
          canvas.width = Math.max(1, Math.round(v.width * scale));
          canvas.height = Math.max(1, Math.round(v.height * scale));
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/png"),
          );
          if (blob && !disposed) {
            owned = URL.createObjectURL(blob);
            setUrl(owned);
          }
        } finally {
          image.src = "";
          canvas.width = canvas.height = 0;
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (owned) URL.revokeObjectURL(owned);
    };
  }, [file]);
  return url ? (
    <img
      src={url}
      width={96}
      height={72}
      style={{ objectFit: "contain" }}
      alt={`${file.name} サムネイル`}
    />
  ) : (
    <span>画像</span>
  );
}
export default function LibraryPanel({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect?: (ref: LibraryRef) => void;
}) {
  const panel = useRef<HTMLDivElement>(null),
    controller = useRef<AbortController | null>(null);
  const [files, setFiles] = useState<LibraryFile[]>([]),
    [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("newest"),
    [trash, setTrash] = useState(false);
  const [assetName, setAssetName] = useState("");
  const [name, setName] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<LibraryFile>(),
    [detail, setDetail] = useState(""),
    [page, setPage] = useState(0);
  const refresh = async () => {
    setFiles(await listFiles());
    setFolders(await listFolders());
  };
  useEffect(() => {
    const opener = document.activeElement as HTMLElement;
    panel.current?.focus();
    void refresh().catch((e) => setError(String(e)));
    return () => {
      controller.current?.abort();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const action = async (task: () => Promise<void>) => {
    setError("");
    try {
      await task();
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "保存できませんでした。端末の空き容量を確認してください",
      );
    }
  };
  const visible = files
    .filter(
      (f) =>
        f.deleted === trash &&
        (query
          ? f.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())
          : f.folderId === folderId),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : b.createdAt.localeCompare(a.createdAt),
    );
  const folder = folders.find((f) => f.id === folderId);
  return (
    <div className="library-overlay">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="素材ライブラリー"
        tabIndex={-1}
        className="library-panel"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.stopPropagation();
            onClose();
          }
          if (e.key === "Tab") {
            const items = [
              ...panel.current!.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled),select:not(:disabled)",
              ),
            ];
            const first = items[0],
              last = items[items.length - 1];
            if (
              e.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === panel.current)
            ) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2>素材ライブラリー</h2>
          <button disabled={busy} onClick={onClose}>
            ライブラリーを閉じる
          </button>
        </header>
        <p>
          画像を取り込み、素材入力ノードの「ライブラリーから画像を選ぶ」で使用できます。音声・動画の編集は未対応です。
        </p>
        <label>
          画像を取り込む（複数選択可）
          <input
            aria-label="ライブラリーに画像を取り込む"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            disabled={busy || trash}
            onChange={(e) => {
              const batch = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (!batch.length) return;
              const abort = new AbortController();
              controller.current = abort;
              setBusy(true);
              setError("");
              void (async () => {
                let count = 0;
                try {
                  for (const f of batch) {
                    abort.signal.throwIfAborted();
                    await importLibraryImage(f, folderId, abort.signal);
                    setNotice(
                      `${++count}/${batch.length}件 取り込み済み（同一原本は再利用）`,
                    );
                  }
                } catch (err) {
                  setError(
                    abort.signal.aborted
                      ? `取り込みを中断しました。完了した${count}件は保持しています`
                      : `取り込み失敗。完了した${count}件は保持しています。${err instanceof Error ? err.message : "空き容量を確認してください"}`,
                  );
                } finally {
                  setBusy(false);
                  controller.current = null;
                  await refresh();
                }
              })();
            }}
          />
        </label>
        {busy && (
          <button onClick={() => controller.current?.abort()}>
            取り込みを中断
          </button>
        )}
        <p role="status">{notice}</p>
        {error && <p role="alert">{error}</p>}
        <div className="button-row">
          <button
            onClick={() => {
              setTrash(!trash);
              setSelected(undefined);
              setPage(0);
            }}
          >
            {trash ? "素材一覧へ" : "ゴミ箱・復元"}
          </button>
          <button onClick={() => void action(refresh)}>一覧を更新</button>
        </div>
        <label>
          素材検索
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <label>
          並び順
          <select
            aria-label="並び順"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="newest">新しい順</option>
            <option value="name">素材名順</option>
          </select>
        </label>
        <label>
          表示フォルダ
          <select
            aria-label="表示フォルダ"
            value={folderId ?? ""}
            onChange={(e) => {
              setFolderId(e.target.value || null);
              setPage(0);
            }}
          >
            <option value="">ルート</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}（
                {f.parentId
                  ? folders.find((p) => p.id === f.parentId)?.name
                  : "ルート"}
                ）
              </option>
            ))}
          </select>
        </label>
        <label>
          フォルダ名
          <input
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button
          disabled={!name.trim() || busy}
          onClick={() =>
            void action(async () => {
              await putFolder({
                id: crypto.randomUUID(),
                name,
                parentId: folderId,
              });
              setName("");
            })
          }
        >
          フォルダ作成
        </button>
        {folder && (
          <>
            <button
              disabled={!name.trim() || busy}
              onClick={() =>
                void action(async () => {
                  await putFolder({ ...folder, name });
                  setName("");
                })
              }
            >
              フォルダ名を変更
            </button>
            <label>
              フォルダの移動先
              <select
                aria-label="フォルダの移動先"
                value={folder.parentId ?? ""}
                onChange={(e) =>
                  void action(async () => {
                    await putFolder({
                      ...folder,
                      parentId: e.target.value || null,
                    });
                  })
                }
              >
                <option value="">ルート</option>
                {folders
                  .filter((f) => f.id !== folder.id)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </label>
          </>
        )}
        <ul>
          {visible.slice(page * 12, page * 12 + 12).map((file) => (
            <li key={file.id}>
              <Thumbnail file={file} />
              <button
                onClick={() => {
                  setSelected(file);
                  setAssetName(file.name);
                  void versionFor(file)
                    .then((v) =>
                      setDetail(
                        `${v.mime} / ${v.width}×${v.height} / ${v.size} bytes / version ${v.id} / hash ${v.hash}`,
                      ),
                    )
                    .catch((e) => setError(String(e)));
                }}
              >
                {file.name}
              </button>
              {onSelect && !trash && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      onSelect(libraryRef(await versionFor(file)));
                    })
                  }
                >
                  この画像を選択：{file.name}
                </button>
              )}
            </li>
          ))}
        </ul>
        {!visible.length && <p>素材がありません。画像を取り込んでください。</p>}
        <button disabled={page === 0} onClick={() => setPage(page - 1)}>
          前の素材
        </button>
        <button
          disabled={(page + 1) * 12 >= visible.length}
          onClick={() => setPage(page + 1)}
        >
          次の素材
        </button>
        {selected && (
          <section aria-label="素材の詳細">
            <h3>{selected.name}</h3>
            <p style={{ overflowWrap: "anywhere" }}>{detail}</p>
            <p>
              削除は一覧から隠す操作です。参照中のversionと原本は保持されます。
            </p>
            <label>
              素材名
              <input
                aria-label="素材名"
                value={assetName}
                maxLength={200}
                onChange={(e) => setAssetName(e.target.value)}
              />
            </label>
            <button
              disabled={!assetName.trim()}
              onClick={() =>
                void action(async () => {
                  await updateFile(selected.id, { name: assetName });
                  setSelected(undefined);
                })
              }
            >
              素材名を変更
            </button>
            <label>
              素材の移動先
              <select
                aria-label="素材の移動先"
                value={selected.folderId ?? ""}
                onChange={(e) =>
                  void action(async () => {
                    await updateFile(selected.id, {
                      folderId: e.target.value || null,
                    });
                    setSelected(undefined);
                  })
                }
              >
                <option value="">ルート</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() =>
                void action(async () => {
                  await updateFile(selected.id, { deleted: !selected.deleted });
                  setSelected(undefined);
                })
              }
            >
              {selected.deleted ? "素材を復元" : "素材を削除"}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
