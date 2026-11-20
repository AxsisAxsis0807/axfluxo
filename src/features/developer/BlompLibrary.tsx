"use client";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { blompRole, type BlompFile } from "../../domain/blomp/storage";
import {
  checkedBlompUrl,
  currentBlompClient,
  importBlompSource,
  uploadBlomp,
} from "../../services/blomp/client";
import { UploadError, value } from "../../services/cloud-library/upload";
import { LIMITS } from "../../config/limits";
import { localExportQueue } from "../../services/video/local-export-runtime";

const roleLabels: Record<BlompFile["role"], string> = {
  inputs: "入力素材",
  originals: "原本素材",
  intermediates: "途中素材",
  checkpoints: "チェックポイント",
  outputs: "完成成果物",
};

const statuses: Record<BlompFile["status"], string> = {
  queued: "アップロード待ち",
  creating: "照合待ち",
  uploading: "アップロード中／状態確認待ち",
  interrupted: "中断",
  completing: "完了確認待ち",
  verifying: "整合性検証中",
  ready: "クラウド保存完了",
  failed: "整合性検証失敗",
  aborting: "キャンセル確認待ち",
  cancelled: "キャンセル済み",
};
const bytes = (size: number | null) =>
  size === null
    ? "未確認"
    : size < 1024 ** 2
      ? `${new Intl.NumberFormat("ja-JP").format(size)} B`
      : `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(size / 1024 ** 2)} MiB`;
const errorMessage = (error: unknown) => {
  const code = error instanceof UploadError ? error.code : "";
  switch (code) {
    case "UPLOAD_FILE_MISMATCH":
      return "保存開始時と同じ元ファイルを選び直してください。";
    case "BLOMP_FILE_LIMIT":
      return "保存先のファイル上限を超えています。端末に保存するか、小さいファイルを選んでください。";
    case "BLOMP_AUTH_EXPIRED":
      return "保存先の認証期限が切れています。管理者に接続設定の確認を依頼してください。";
    case "BLOMP_AUTH_FAILED":
      return "保存先の認証または権限を確認できません。端末保存を利用できます。";
    case "BLOMP_ACCOUNT_UNAVAILABLE":
      return "保存先アカウントは利用できません。端末保存を利用できます。";
    case "BLOMP_CAPACITY_HELD":
      return "保存先の容量が不足しています。端末保存を利用できます。";
    case "BLOMP_RATE_LIMITED":
      return "保存先の通信制限に達しました。時間をおいて状態を確認してください。";
    case "BLOMP_WRITES_HELD":
      return "保存先の上限または転送条件を確認できないため、書き込みを保留しています。端末保存を利用できます。";
    case "BLOMP_STATE_CONFLICT":
      return "状態を更新してください。転送署名の有効期間中や照合中は処理を保留する場合があります。";
    case "BLOMP_OPERATION_UNCONFIRMED":
      return "処理の結果を確認できませんでした。一覧を更新して状態を確認してください。";
    default:
      return "操作を完了できませんでした。接続・ログイン・容量を確認し、必要なら一覧から再開してください。";
  }
};

function writeHoldMessage(overview: {
  capabilities?: { maxFileBytes: number | null; multipartWrites: boolean };
  available: number | null;
}) {
  if (overview.capabilities?.maxFileBytes === null)
    return "Blompの公式ファイル上限が未確認です。確認できるまでクラウド保存を保留します。";
  if (overview.capabilities?.multipartWrites === false)
    return "Blompの直接転送・無料利用条件の確認待ちです。";
  if (overview.available === null)
    return "Blompの容量を確認できません。端末保存を利用できます。";
  return "Blompの書き込み受付は停止中です。端末保存を利用できます。";
}

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}
const onlineSnapshot = () => navigator.onLine;
const onlineOnServer = () => true;

export function BlompUpload({
  source,
  resume,
  onChange,
}: {
  source?: { blob: Blob; name: string };
  resume?: BlompFile;
  onChange?: () => void;
}) {
  const api = useMemo(() => currentBlompClient(), []);
  const online = useSyncExternalStore(
    subscribeOnline,
    onlineSnapshot,
    onlineOnServer,
  );
  const [selected, setSelected] = useState<File | null>(null);
  const [role, setRole] = useState<BlompFile["role"]>("originals");
  const [active, setActive] = useState(false);
  const [sent, setSent] = useState(0);
  const [message, setMessage] = useState("");
  const control = useRef<AbortController | null>(null);
  useEffect(() => {
    const stop = () => control.current?.abort();
    const visibility = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("offline", stop);
    window.addEventListener("pagehide", stop);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("offline", stop);
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, []);
  if (!api) return null;
  async function start() {
    const blob = source?.blob ?? selected;
    const name = source?.name ?? selected?.name;
    if (!api || !blob || !name || control.current) return;
    if (
      localExportQueue
        .getSnapshot()
        .entries.some(
          ({ state }) => state === "rendering" || state === "preparing",
        )
    ) {
      setMessage("端末の書き出しが終了してから転送してください。");
      return;
    }
    const controller = new AbortController();
    control.current = controller;
    const stopOnEncode = localExportQueue.subscribe(() => {
      if (
        localExportQueue
          .getSnapshot()
          .entries.some(
            ({ state }) => state === "rendering" || state === "preparing",
          )
      )
        controller.abort();
    });
    setActive(true);
    setSent(0);
    setMessage("受付とファイルの整合性を確認しています…");
    try {
      if (!resume) {
        const overview = value(await api.overview());
        if (
          overview.state !== "available" ||
          overview.capabilities?.maxFileBytes === null
        ) {
          setMessage(writeHoldMessage(overview));
          return;
        }
        const limit = overview.capabilities?.maxFileBytes;
        if (limit != null && blob.size > limit) {
          setMessage(errorMessage(new UploadError("BLOMP_FILE_LIMIT")));
          return;
        }
        if (overview.available !== null && blob.size > overview.available) {
          setMessage(errorMessage(new UploadError("BLOMP_CAPACITY_HELD")));
          return;
        }
      }
      const destinationRole = resume?.role ?? (source ? "outputs" : role);
      const mime =
        blob.type.split(";")[0].trim().toLowerCase() ||
        (destinationRole === "checkpoints" ? "application/octet-stream" : "");
      const result = await uploadBlomp({
        api,
        blob,
        input: {
          name,
          mime: mime as BlompFile["mime"],
          role: destinationRole,
          projectId: resume?.projectId ?? null,
          jobId: resume?.jobId ?? null,
        },
        resumeId: resume?.id,
        signal: controller.signal,
        progress: setSent,
      });
      setMessage(statuses[result.status]);
    } catch (error) {
      setMessage(
        controller.signal.aborted
          ? "転送を中断しました。元ファイルを選んで再開できます。"
          : errorMessage(error),
      );
    } finally {
      stopOnEncode();
      control.current = null;
      setActive(false);
      onChange?.();
    }
  }
  return (
    <div>
      {!source && (
        <>
          {!resume && (
            <label>
              保存する種類{" "}
              <select
                value={role}
                onChange={(e) => setRole(blompRole.parse(e.target.value))}
              >
                {blompRole.options.map((option) => (
                  <option key={option} value={option}>
                    {roleLabels[option]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {resume ? "元ファイルを選び直す" : "Blompへ保存するファイル"}{" "}
            <input
              type="file"
              accept={
                (resume?.role ?? role) === "checkpoints"
                  ? undefined
                  : "video/*,audio/*,image/*"
              }
              disabled={active}
              onChange={(e) => setSelected(e.target.files?.[0] ?? null)}
            />
          </label>
        </>
      )}
      <button
        type="button"
        disabled={!online || active || (!source && !selected)}
        onClick={() => void start()}
      >
        {resume ? "転送を再開" : "Blompに保存"}
      </button>
      {active && (
        <>
          <progress
            max={source?.blob.size || selected?.size || 1}
            value={sent}
            aria-label="Blomp転送進捗"
          />
          <span>{bytes(sent)} 転送済み</span>
          <button type="button" onClick={() => control.current?.abort()}>
            中断
          </button>
        </>
      )}
      {!online && (
        <p role="status">オフラインです。端末内のファイルは保持されます。</p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

export default function BlompLibrary({
  onUseSource,
  sourceKind = "image",
}: {
  onUseSource?: (source: File) => Promise<void>;
  sourceKind?: "image" | "video" | "media";
} = {}) {
  const api = useMemo(() => currentBlompClient(), []);
  const online = useSyncExternalStore(
    subscribeOnline,
    onlineSnapshot,
    onlineOnServer,
  );
  const [overview, setOverview] = useState<Awaited<
    ReturnType<NonNullable<typeof api>["overview"]>
  > | null>(null);
  const [files, setFiles] = useState<BlompFile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [newest, setNewest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<{
    url: string;
    expiresAt: number;
    id: string;
  } | null>(null);
  useEffect(() => {
    if (!access) return;
    const expire = setTimeout(
      () => setAccess(null),
      Math.max(0, access.expiresAt - Date.now()),
    );
    return () => clearTimeout(expire);
  }, [access]);
  async function refresh(next?: string) {
    if (!api) return;
    setBusy(true);
    setMessage("");
    try {
      const status = await api.overview();
      setOverview(status);
      const current = value(status);
      if (current.state === "disabled") {
        setFiles([]);
        setCursor(null);
        setAccess(null);
        return;
      }
      const page = value(await api.list(next));
      setFiles((previous) =>
        next ? [...previous, ...page.files] : page.files,
      );
      setCursor(page.cursor);
    } catch (error) {
      setFiles([]);
      setCursor(null);
      setAccess(null);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const importLimit =
    sourceKind === "image" ? LIMITS.imageBytes : 16 * 1024 ** 2;
  const matchesSource = (file: BlompFile) =>
    sourceKind === "image"
      ? file.mime.startsWith("image/")
      : file.mime.startsWith("video/") ||
        (sourceKind === "media" && file.mime.startsWith("audio/"));
  async function importSource(file: BlompFile) {
    if (!api || !onUseSource) return;
    setBusy(true);
    setMessage("");
    try {
      await onUseSource(await importBlompSource(api, file, importLimit));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function operate(file: BlompFile, cancel: boolean) {
    if (!api) return;
    setBusy(true);
    setMessage("");
    setAccess(null);
    try {
      if (cancel) {
        const result = value(await api.cancel(file.id));
        setFiles((items) =>
          items.map((item) => (item.id === result.id ? result : item)),
        );
      } else {
        const signed = value(await api.download(file.id));
        setAccess({ ...signed, url: checkedBlompUrl(signed.url), id: file.id });
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>Blompストレージ</summary>
      {api ? (
        <>
          <button
            type="button"
            disabled={!online || busy}
            onClick={() => void refresh()}
          >
            状態と一覧を更新
          </button>
          <p role="status">
            {!online
              ? "オフラインです。"
              : !overview
                ? "接続状態は未確認です。"
                : !overview.ok || overview.data.state === "disabled"
                  ? "接続を確認できません。"
                  : overview.data.state === "held"
                    ? writeHoldMessage(overview.data)
                    : "書き込み受付中"}
          </p>
          {overview?.ok && (
            <dl>
              <dt>契約容量</dt>
              <dd>{bytes(overview.data.capacity)}</dd>
              <dt>最終確認時の使用量</dt>
              <dd>{bytes(overview.data.measuredUsed)}</dd>
              <dt>推定使用量</dt>
              <dd>{bytes(overview.data.estimatedUsed)}</dd>
              {overview.data.capabilities && (
                <>
                  <dt>ファイル上限（確認済み）</dt>
                  <dd>{bytes(overview.data.capabilities.maxFileBytes)}</dd>
                </>
              )}
              <dt>受付可能容量</dt>
              <dd>{bytes(overview.data.available)}</dd>
              <dt>予約済み</dt>
              <dd>{bytes(overview.data.reserved)}</dd>
              <dt>最終確認時刻</dt>
              <dd>
                {overview.data.verifiedAt
                  ? new Date(overview.data.verifiedAt).toLocaleString()
                  : "未確認"}
              </dd>
            </dl>
          )}
          {overview?.ok &&
            !onUseSource &&
            overview.data.state === "available" && (
              <BlompUpload onChange={() => void refresh()} />
            )}
          {message && <p role="status">{message}</p>}
          {files.length > 0 && (
            <>
              <label>
                ファイル名を検索{" "}
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <label>
                並べ替え{" "}
                <select
                  value={newest ? "newest" : "name"}
                  onChange={(e) => setNewest(e.target.value === "newest")}
                >
                  <option value="newest">作成日時の新しい順</option>
                  <option value="name">ファイル名順</option>
                </select>
              </label>
            </>
          )}
          {(onUseSource
            ? (["inputs", "originals"] as const)
            : blompRole.options
          ).map((role) => (
            <section key={role}>
              <h3>{roleLabels[role]}</h3>
              <ul>
                {files
                  .filter(
                    (file) =>
                      file.role === role &&
                      (!onUseSource ||
                        (file.status === "ready" && matchesSource(file))) &&
                      file.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .sort((a, b) =>
                    newest
                      ? b.createdAt.localeCompare(a.createdAt)
                      : a.name.localeCompare(b.name),
                  )
                  .map((file) => (
                    <li key={file.id}>
                      <strong>{file.name}</strong> {file.mime}・
                      {bytes(file.size)}・{statuses[file.status]}・
                      {new Date(file.createdAt).toLocaleString()}
                      {file.projectId && (
                        <span> プロジェクト {file.projectId}</span>
                      )}
                      {file.status === "ready" && (
                        <button
                          type="button"
                          disabled={!online || busy}
                          onClick={() => void operate(file, false)}
                        >
                          ダウンロードを準備
                        </button>
                      )}
                      {onUseSource && file.size <= importLimit && (
                        <button
                          type="button"
                          disabled={!online || busy}
                          onClick={() => void importSource(file)}
                        >
                          端末の編集に使う
                        </button>
                      )}
                      {onUseSource && file.size > importLimit && (
                        <p>
                          ダウンロード後、端末の素材として選択してください。
                        </p>
                      )}
                      {access?.id === file.id && (
                        <a
                          href={access.url}
                          download={file.name}
                          referrerPolicy="no-referrer"
                        >
                          ダウンロード
                        </a>
                      )}
                      {[
                        "queued",
                        "creating",
                        "uploading",
                        "interrupted",
                        "completing",
                        "verifying",
                      ].includes(file.status) &&
                        overview?.ok &&
                        overview.data.state !== "disabled" && (
                          <BlompUpload
                            resume={file}
                            onChange={() => void refresh()}
                          />
                        )}
                      {[
                        "queued",
                        "creating",
                        "uploading",
                        "interrupted",
                        "aborting",
                      ].includes(file.status) && (
                        <button
                          type="button"
                          disabled={!online || busy}
                          onClick={() => void operate(file, true)}
                        >
                          アップロードをキャンセル
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
            </section>
          ))}
          {cursor && (
            <button
              type="button"
              disabled={!online || busy}
              onClick={() => void refresh(cursor)}
            >
              次のページ
            </button>
          )}
        </>
      ) : (
        <p>Blomp APIの設定を確認できません。</p>
      )}
    </details>
  );
}
