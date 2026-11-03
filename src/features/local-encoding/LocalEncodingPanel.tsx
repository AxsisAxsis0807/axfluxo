"use client";
import { useEffect, useRef, useState } from "react";
import {
  asset,
  jobs,
  read,
  saveJob,
  removeJob,
  MAX_BYTES,
  type Snapshot,
  type LocalJob,
} from "../../services/local-encoding/storage";
import { plan, refs, validate } from "../../services/local-encoding/plan";
import { runQueue } from "../../services/local-encoding/queue";
import { WasmEngine } from "../../services/local-encoding/engine";
import type { MediaVersionRef } from "../../domain/cloud-library/schema";
export function LocalEncodingPanel({
  owner,
  snapshot,
  authorize,
  materialize,
}: {
  owner: string;
  snapshot: () => Snapshot;
  authorize: () => Promise<boolean>;
  materialize?: (ref: MediaVersionRef) => Promise<void>;
}) {
  const [items, setItems] = useState<LocalJob[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [clock, setClock] = useState(0),
    [saving, setSaving] = useState(false),
    [urls, setUrls] = useState<Record<string, string>>({});
  const active = useRef<{ stop: AbortController; done: Promise<void> } | null>(
      null,
    ),
    live = useRef(true),
    mutating = useRef(false);
  const urlRefs = useRef<string[]>([]);
  const refresh = () => {
    void jobs(owner)
      .then((rows) => {
        if (live.current) setItems(rows);
      })
      .catch(() => {
        if (live.current) setError("端末の保存領域を利用できません。");
      });
  };
  useEffect(() => {
    live.current = true;
    const timer = setInterval(() => {
      refresh();
      setClock(Date.now());
    }, 1000);
    refresh();
    const hide = () => {
      if (document.visibilityState !== "visible") active.current?.stop.abort();
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", hide);
    return () => {
      live.current = false;
      active.current?.stop.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", hide);
      urlRefs.current.forEach(URL.revokeObjectURL);
      urlRefs.current = [];
    };
    // Owner-scoped lifetime; job polling does not restart encoding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  async function add() {
    if (mutating.current) return;
    mutating.current = true;
    setSaving(true);
    setError("");
    try {
      if (!(await authorize()))
        throw Error("開発者権限を確認できません。再ログインしてください。");
      const data = validate(structuredClone(snapshot()));
      for (const ref of refs(data)) {
        let row = await asset(owner, ref.versionId);
        if (!row && materialize) {
          await materialize(ref);
          row = await asset(owner, ref.versionId);
        }
        if (!row || row.reference.hash !== ref.hash)
          throw Error("端末内に原本がありません。素材を読み込んでください。");
      }
      const names =
        data.kind === "fnf-showcase-snapshot"
          ? data.names
          : [`all-versions-${data.id}.mp4`];
      for (let i = 0; i < names.length; i++) {
        const job: LocalJob = {
          id: crypto.randomUUID(),
          owner,
          snapshot: data,
          outputIndex: i,
          filename: names[i],
          state: "queued",
          next: 0,
          total: plan(data, i).length,
          activeMs: 0,
          restUntil: 0,
          createdAt: Date.now() + i,
        };
        await saveJob(job);
      }
      await navigator.storage?.persist?.();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "キューに保存できません。");
    } finally {
      mutating.current = false;
      setSaving(false);
    }
  }
  async function start() {
    if (active.current || mutating.current) return;
    if (!navigator.locks) {
      setError(
        "このブラウザは安全な端末内キューに未対応です。Web Locks対応ブラウザを使用してください。",
      );
      return;
    }
    const stop = new AbortController();
    setBusy(true);
    setError("");
    const done = (async () => {
      await navigator.locks.request(
        "axfluxo-local-encoder",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw Error("別のタブで端末内キューを処理しています。");
          if (!(await authorize())) throw Error("開発者権限を確認できません。");
          stop.signal.throwIfAborted();
          if (document.visibilityState !== "visible")
            throw Error("画面を開いて再開してください。");
          for (const j of await jobs(owner))
            if (j.state === "failed") {
              j.state = "paused";
              j.error = undefined;
              await saveJob(j);
            }
          const engine = new WasmEngine(),
            abort = () => engine.dispose();
          stop.signal.addEventListener("abort", abort, { once: true });
          try {
            await runQueue(owner, engine, stop.signal, refresh);
          } finally {
            stop.signal.removeEventListener("abort", abort);
          }
        },
      );
    })()
      .catch((e) => {
        if (live.current && !stop.signal.aborted)
          setError(e instanceof Error ? e.message : "処理できません。");
      })
      .finally(() => {
        active.current = null;
        if (live.current) {
          setBusy(false);
          refresh();
        }
      });
    active.current = { stop, done };
  }
  async function cancel(job: LocalJob) {
    if (mutating.current) return;
    mutating.current = true;
    try {
      active.current?.stop.abort();
      await active.current?.done;
      await navigator.locks.request(
        "axfluxo-local-encoder",
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw Error("別タブの処理を停止してから中止してください。");
          const latest = await read<LocalJob>(owner, `job:${job.id}`);
          if (!latest) return;
          latest.state = "cancelled";
          await saveJob(latest);
          refresh();
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "中止できません。");
    } finally {
      mutating.current = false;
    }
  }
  async function showOutput(job: LocalJob) {
    try {
      const blob = await read<Blob>(owner, `output:${job.id}`);
      if (!blob) throw Error("完成動画を読み込めません。");
      if (urls[job.id]) return;
      const url = URL.createObjectURL(blob);
      urlRefs.current.push(url);
      setUrls((old) => ({ ...old, [job.id]: url }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存できません。");
    }
  }
  async function remove(job: LocalJob) {
    try {
      await navigator.locks.request(
        "axfluxo-local-encoder",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw Error("キュー停止後に削除してください。");
          await removeJob(owner, job.id);
          refresh();
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除できません。");
    }
  }
  const labels: Record<LocalJob["state"], string> = {
    queued: "待機",
    running: "処理中／前回中断なら再開してください",
    resting: "休憩中",
    paused: "一時停止",
    cancelled: "中止",
    failed: "失敗・保存済み区切りから再試行可能",
    completed: "完成",
  };
  return (
    <section
      aria-label="Local Low-Load Encoding"
      style={{
        border: "1px solid #777",
        padding: 16,
        marginBlock: 16,
        overflowWrap: "anywhere",
      }}
    >
      <h2>Local Low-Load Encoding</h2>
      <p>書き出し方式：端末内エンコード（標準） ／ モード：低負荷エンコード</p>
      <p>連続処理：10分 ／ 休憩：4分 ／ 60fps・MP4（H.264 / AAC 320kbps）</p>
      <p>
        Safariを開いたまま処理してください。画面ロック・バックグラウンド移行・OSのメモリー回収で中断する場合があります。再開は保存済みチャンクから行い、処理途中のチャンクはやり直します。
      </p>
      <p>
        10分・4分は発熱抑制を保証しません。安全な区切りまで停止が遅れる場合があります。素材と最終結合の各上限は
        {MAX_BYTES / 1024 / 1024}
        MiBです。容量不足・ブラウザによる端末データ削除では復旧できない場合があります。
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          style={{ minHeight: 44 }}
          disabled={saving}
          onClick={() => void add()}
        >
          現在の編集内容をキューに追加
        </button>
        <button
          style={{ minHeight: 44 }}
          disabled={
            busy ||
            saving ||
            !items.some((j) => !["completed", "cancelled"].includes(j.state))
          }
          onClick={() => void start()}
        >
          書き出し開始・再開
        </button>
        <button
          style={{ minHeight: 44 }}
          disabled={!busy}
          onClick={() => active.current?.stop.abort()}
        >
          一時停止
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <h3>書き出しキュー（この端末・現在の開発者）</h3>
      <ol>
        {items.map((job) => (
          <li key={job.id} style={{ marginBlock: 12 }}>
            <p>
              {job.filename} — {labels[job.state]}
            </p>
            <progress
              aria-label={`${job.filename} 処理進捗`}
              max={job.total + 1}
              value={job.next + (job.state === "completed" ? 1 : 0)}
            />
            <span>
              {" "}
              {job.next}/{job.total} チャンク
              {job.next === job.total && job.state !== "completed"
                ? "・最終結合待ち"
                : ""}
            </span>
            {job.restUntil > clock && (
              <p role="status">
                休憩中の残り時間：{Math.ceil((job.restUntil - clock) / 1000)}秒
              </p>
            )}
            {job.error && <p role="alert">{job.error}</p>}
            {!["completed", "cancelled"].includes(job.state) && (
              <button
                style={{ minHeight: 44 }}
                onClick={() => void cancel(job)}
              >
                中止
              </button>
            )}
            {job.state === "completed" && (
              <>
                <button
                  style={{ minHeight: 44 }}
                  onClick={() => void showOutput(job)}
                >
                  完成動画の保存を準備
                </button>
                {urls[job.id] && (
                  <a
                    style={{ display: "inline-block", padding: 12 }}
                    href={urls[job.id]}
                    download={job.filename}
                  >
                    MP4を端末に保存
                  </a>
                )}
              </>
            )}
            {["completed", "cancelled", "failed"].includes(job.state) && (
              <button
                style={{ minHeight: 44 }}
                disabled={busy}
                onClick={() => void remove(job)}
              >
                このジョブと生成物を端末から削除
              </button>
            )}
          </li>
        ))}
      </ol>
      <p>
        Server
        Encoding：通常の書き出しでは利用しません。既存のサーバー設定・ジョブ・完成物は保持しています。
      </p>
    </section>
  );
}
