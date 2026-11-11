"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { toFrame } from "../../domain/video/time";
import {
  exportLimits,
  exportOutputName,
  EXPORT_PROFILE,
  type ExportJobView,
  type ExportSessionView,
} from "../../domain/cloud-export/schema";
import type { Source } from "../../services/video/local-project";
import {
  currentVideoSessionSource,
  type VideoSessionSource,
} from "../../services/video/api-client";
import {
  createCloudExportClient,
  type CloudExportClient,
} from "../../services/video/cloud-export-client";

const JOB_KEY = "axfluxo.cloud-export.job.v1";
const messages: Record<string, string> = {
  EXPORT_DISABLED: "サーバー書き出しは現在受け付けていません。",
  EXPORT_LIMIT_EXCEEDED:
    "素材または書き出しが上限を超えています。短い区間で試してください。",
  EXPORT_HASH_MISMATCH: "素材の検証に失敗しました。もう一度選び直してください。",
  EXPORT_INPUT_UNSUPPORTED:
    "この素材または編集内容はサーバー書き出しに対応していません。",
  EXPORT_INPUT_CORRUPT: "素材を読み取れませんでした。元の動画を確認してください。",
  EXPORT_INPUT_MISSING: "素材が見つかりません。もう一度送信してください。",
  EXPORT_OUTPUT_INVALID:
    "出来上がった動画の検証に失敗しました。もう一度実行してください。",
  EXPORT_TIMEOUT: "処理時間の上限に達しました。短い区間で試してください。",
  EXPORT_DISK_FULL: "サーバーの空き容量が不足しています。時間をおいてください。",
  EXPORT_OUT_OF_MEMORY:
    "サーバーのメモリが不足しました。短い区間で試してください。",
  EXPORT_WORKER_LOST:
    "処理サーバーが中断しました。状態を確認して、もう一度実行してください。",
  EXPORT_CANCELLED: "書き出しは取り消されました。",
  EXPORT_STORAGE_UNAVAILABLE:
    "サーバーに一時的な問題が起きています。時間をおいて確認してください。",
  EXPORT_LEASE_LOST: "処理サーバーの担当が切り替わりました。",
  EXPORT_BUSY: "書き出しはまだ実行中です。",
  EXPORT_NOT_FOUND: "ジョブが見つかりません。",
  EXPORT_CONFLICT: "同じ操作が既に処理されています。状態を確認してください。",
  EXPORT_BLOB_INCOMPLETE: "素材の送信が完了していません。",
  EXPORT_BLOB_UNAVAILABLE: "素材をもう一度送信してください。",
};

type ClipPlan = {
  source: Source;
  startUs: number;
  endUs: number;
  markersUs: number[];
};
type Plan =
  | {
      ok: true;
      clips: ClipPlan[];
      names: string[];
      versions: number;
      totalFrames: number;
      totalBytes: number;
    }
  | { ok: false; issue: string };

function buildPlan(
  sources: Source[],
  names: string,
  cover: File | undefined,
  limits: { maxFrames: number; maxUploadBytes: number },
): Plan {
  if (!sources.length) return { ok: false, issue: "素材を選択してください。" };
  const clips: ClipPlan[] = [];
  let offsetUs = 0,
    versions = 0,
    totalBytes = 0;
  for (const source of sources) {
    const { start, end, duration } = source;
    if (
      ![start, end, duration].every(Number.isFinite) ||
      start < 0 ||
      end <= start ||
      end > duration
    )
      return {
        ok: false,
        issue: "開始・終了時刻を素材の長さの範囲内で指定してください。",
      };
    const markers = source.markers.trim()
      ? source.markers.split(",").map((v) => Number(v.trim()))
      : [];
    if (
      markers.some(
        (m, i) =>
          !Number.isFinite(m) || m <= start || m >= end || (i > 0 && m <= markers[i - 1]),
      )
    )
      return {
        ok: false,
        issue: "Version境界は区間内の秒数を昇順・カンマ区切りで指定してください。",
      };
    const startUs = Math.round(start * 1e6),
      endUs = Math.round(end * 1e6);
    clips.push({
      source,
      startUs,
      endUs,
      markersUs: markers.map((m) => Math.round(m * 1e6)),
    });
    offsetUs += endUs - startUs;
    versions += markers.length + 1;
    totalBytes += source.file.size;
    if (source.file.size > limits.maxUploadBytes)
      return {
        ok: false,
        issue: `1本の素材は${Math.floor(limits.maxUploadBytes / 1024 ** 2)}MiBまでです。`,
      };
  }
  if (!cover) return { ok: false, issue: "カバー画像を選択してください。" };
  if (cover.size <= 0 || cover.size > exportLimits.maxImageBytes)
    return {
      ok: false,
      issue: `カバー画像は${exportLimits.maxImageBytes / 1024 ** 2}MiBまでです。`,
    };
  const labels = names.replace(/\r\n?/g, "\n").split("\n");
  if (labels.length !== versions || labels.some((v) => !v.trim()))
    return {
      ok: false,
      issue: `Version名は${versions}行必要です。素材のVersion境界と名前を確認してください。`,
    };
  if (labels.some((v) => v.trim().length > exportLimits.maxNameLength))
    return {
      ok: false,
      issue: `Version名は1行${exportLimits.maxNameLength}文字までです。`,
    };
  let totalFrames = 0;
  offsetUs = 0;
  for (const clip of clips) {
    const duration = clip.endUs - clip.startUs;
    totalFrames += toFrame(offsetUs + duration) - toFrame(offsetUs);
    offsetUs += duration;
  }
  if (totalFrames <= 0) return { ok: false, issue: "区間が短すぎます。" };
  if (totalFrames > limits.maxFrames)
    return {
      ok: false,
      issue: `書き出しは${Math.floor(limits.maxFrames / 60)}秒までです。区間を短くしてください。`,
    };
  return {
    ok: true,
    clips,
    names: labels.map((v) => v.trim()),
    versions,
    totalFrames,
    totalBytes,
  };
}

function terminal(job: ExportJobView) {
  return ["succeeded", "failed", "cancelled"].includes(job.state);
}

export default function CloudExportPanel({
  sources,
  names,
  cover,
}: {
  sources: Source[];
  names: string;
  cover?: File;
}) {
  const client = useMemo<CloudExportClient | null>(() => {
    const baseUrl = process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
    const session = currentVideoSessionSource() as VideoSessionSource | null;
    if (!baseUrl || !session) return null;
    try {
      return createCloudExportClient({ baseUrl, session });
    } catch {
      return null;
    }
  }, []);
  const [session, setSession] = useState<ExportSessionView | null>(null);
  const [job, setJob] = useState<ExportJobView | null>(null);
  const [jobId, setJobId] = useState("");
  const [phase, setPhase] = useState<
    "idle" | "uploading" | "accepted" | "downloading"
  >("idle");
  const [progress, setProgress] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [output, setOutput] = useState("");
  const terminalRef = useRef(false);
  const keyRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef("");

  useEffect(() => {
    let live = true;
    retry: {
      if (!client) return;
      void client.session().then((result) => {
        if (!live) return;
        if (result.ok) setSession(result.data);
        else if (result.reason === "forbidden")
          setError("開発者権限を確認できません。ログイン状態を確認してください。");
      });
    }
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    if (!client) return;
    try {
      const stored = sessionStorage.getItem(JOB_KEY);
      if (stored && /^[0-9a-fA-F-]{36}$/.test(stored)) setJobId(stored);
    } catch {
      /* storage may be unavailable */
    }
  }, [client]);

  useEffect(() => {
    terminalRef.current = job ? terminal(job) : false;
  }, [job]);

  useEffect(() => {
    if (!client || !jobId || terminalRef.current) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const result = await client.getJob(jobId);
      if (!live) return;
      if (result.ok) {
        setJob(result.data);
        if (result.data.state === "succeeded") setPhase("accepted");
        if (!terminal(result.data)) timer = setTimeout(tick, 3000);
      } else {
        if (result.reason === "auth-expired" || result.reason === "forbidden")
          setError(messages[result.code] ?? "ログイン状態を確認してください。");
        timer = setTimeout(tick, 6000);
      }
    };
    void tick();
    const visible = () => {
      if (document.visibilityState === "visible" && live) void tick();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [client, jobId]);

  useEffect(
    () => () => {
      if (outputRef.current) URL.revokeObjectURL(outputRef.current);
    },
    [],
  );

  if (!client) return null;
  const limits = {
    maxFrames: session?.maxFrames ?? exportLimits.maxFrames,
    maxUploadBytes: session?.maxUploadBytes ?? exportLimits.maxUploadBytes,
  };
  const plan = buildPlan(sources, names, cover, limits);
  const busy = phase === "uploading" || phase === "downloading";
  const running =
    job && ["queued", "running", "cancel_requested"].includes(job.state);

  async function start() {
    if (!client || !plan.ok || busy) return;
    if (session && !session.enabled) {
      setError(messages.EXPORT_DISABLED);
      return;
    }
    if (!keyRef.current) keyRef.current = crypto.randomUUID();
    setError("");
    setOutput("");
    setJob(null);
    setPhase("uploading");
    setProgress(0);
    setNote("素材の検証をしています…");
    const controller = new AbortController();
    abortRef.current = controller;
    const totalBytes = plan.totalBytes + (cover ? cover.size : 0);
    let sent = 0;
    try {
      const upload = async (file: File, kind: "video" | "image", label: string) => {
        const base = sent;
        const result = await client.upload(file, kind, {
          signal: controller.signal,
          onHashing: () => setNote(`${label}を検証しています…`),
          onProgress: (fraction) => {
            setNote(`${label}を送信中… ${Math.floor(fraction * 100)}%`);
            setProgress((base + file.size * fraction) / Math.max(1, totalBytes));
          },
        });
        if (!result.ok)
          throw new Error(messages[result.code] ?? "素材を送信できませんでした。");
        sent += file.size;
        setProgress(sent / Math.max(1, totalBytes));
        return result.data.id;
      };
      const coverId = await upload(cover!, "image", "カバー画像");
      const clips: { blobId: string; startUs: number; endUs: number; markersUs: number[] }[] = [];
      for (let i = 0; i < plan.clips.length; i++) {
        const clip = plan.clips[i];
        const blobId = await upload(
          clip.source.file,
          "video",
          `素材${i + 1}`,
        );
        clips.push({
          blobId,
          startUs: clip.startUs,
          endUs: clip.endUs,
          markersUs: clip.markersUs,
        });
      }
      setNote("ジョブを受け付けています…");
      const created = await client.createJob(
        {
          schemaVersion: 1,
          clips,
          names: plan.names,
          coverBlobId: coverId,
          design: { height: EXPORT_PROFILE.height, fadeInFrames: 9, fadeOutFrames: 9 },
        },
        keyRef.current,
      );
      if (!created.ok)
        throw new Error(messages[created.code] ?? "ジョブを受け付けられませんでした。");
      try {
        sessionStorage.setItem(JOB_KEY, created.data.id);
      } catch {
        /* storage may be unavailable */
      }
      keyRef.current = "";
      setJob(created.data);
      setJobId(created.data.id);
      setPhase("accepted");
      setNote("素材の転送とジョブ受領が完了しました。");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "サーバー書き出しを開始できませんでした。",
      );
      setPhase("idle");
      setNote("");
    } finally {
      abortRef.current = null;
    }
  }

  async function cancel() {
    if (!client || !job) return;
    const result = await client.cancelJob(job.id);
    if (result.ok) setJob(result.data);
    else setError(messages[result.code] ?? "取り消せませんでした。");
  }

  async function download() {
    if (!client || !job) return;
    setPhase("downloading");
    setError("");
    setNote("保存を準備しています…");
    // A one-time URL lets Safari download straight to Files without JS memory.
    const ticket = await client.downloadTicket(job.id);
    if (ticket.ok) {
      window.location.assign(ticket.data.url);
      setNote(
        "ダウンロードを開始しました。Safariのダウンロード（Files）を確認してください。",
      );
      setPhase("accepted");
      return;
    }
    setNote("完成したMP4を取得しています…");
    const result = await client.download(job.id, (fraction) =>
      setNote(`完成したMP4を取得しています… ${Math.floor(fraction * 100)}%`),
    );
    if (!result.ok) {
      setError(messages[result.code] ?? "MP4を取得できませんでした。");
      setPhase("accepted");
      return;
    }
    if (outputRef.current) URL.revokeObjectURL(outputRef.current);
    const url = URL.createObjectURL(result.data);
    outputRef.current = url;
    setOutput(url);
    setNote("");
  }

  async function remove() {
    if (!client || !job) return;
    if (
      !window.confirm(
        "この書き出しと素材をサーバーから削除します。削除後は復元できません。",
      )
    )
      return;
    const result = await client.deleteJob(job.id);
    if (!result.ok) {
      setError(messages[result.code] ?? "サーバーから削除できませんでした。");
      return;
    }
    if (outputRef.current) URL.revokeObjectURL(outputRef.current);
    outputRef.current = "";
    setOutput("");
    setJob(null);
    setJobId("");
    try {
      sessionStorage.removeItem(JOB_KEY);
    } catch {
      /* storage may be unavailable */
    }
    setNote("サーバーから削除しました。");
  }

  return (
    <section aria-label="サーバーで書き出し" className="cloud-export">
      <h2>サーバーで書き出し（最小版）</h2>
      <p>
        All Versionsの編集内容（{EXPORT_PROFILE.width}×{EXPORT_PROFILE.height}・
        {EXPORT_PROFILE.fps}fps・H.264/AAC）をサーバーで作成します。素材・区間・Version名・カバー画像を使用します。
      </p>
      {!session && <p role="status">書き出しサーバーの状態を確認しています…</p>}
      {session && !session.enabled && (
        <p role="alert">{messages.EXPORT_DISABLED}</p>
      )}
      {plan.ok ? (
        <p role="status">
          {plan.versions}Version・{plan.clips.length}素材・
          {(plan.totalFrames / 60).toFixed(1)}秒（{plan.totalFrames}フレーム）
        </p>
      ) : (
        <p role="alert">{plan.issue}</p>
      )}
      {(phase === "uploading" || (running && !job)) && (
        <p role="alert" className="cloud-export-warning">
          素材を送信中です。「受付完了」が表示されるまでSafariを閉じないでください。画面ロックも避けてください。
        </p>
      )}
      {job && running && (
        <p role="status" className="cloud-export-running">
          サーバーが処理しています。Safariを閉じても処理は継続します。再訪時にこの画面で状態を確認できます。
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {progress > 0 && phase === "uploading" && (
        <progress max={1} value={progress} aria-label="素材転送の進捗" />
      )}
      {job && (
        <p role="status">
          状態: {job.state}・{job.completedFrames}/{job.totalFrames}フレーム
        </p>
      )}
      {job && running && <progress max={1} value={job.totalFrames ? job.completedFrames / job.totalFrames : 0} aria-label="書き出しの進捗" />}
      {job?.errorCode && (
        <p role="alert">{messages[job.errorCode] ?? "書き出しに失敗しました。"}</p>
      )}
      {job?.state === "succeeded" && job.output && (
        <p role="status">
          {job.output.width}×{job.output.height}・{job.output.fps}fps・
          {(job.output.size / 1024 ** 2).toFixed(1)}MiBのMP4を作成しました。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {output && (
        <p>
          <a href={output} download={exportOutputName}>
            {exportOutputName}を保存
          </a>
          <br />
          <small>
            保存後は共有メニューから「ビデオを保存」で写真アプリへ保存できます。
          </small>
        </p>
      )}
      <div className="cloud-export-actions">
        <button
          disabled={!plan.ok || busy || Boolean(running)}
          onClick={() => void start()}
        >
          サーバーで書き出し
        </button>
        {job && running && (
          <button onClick={() => void cancel()}>書き出しを取り消す</button>
        )}
        {job?.state === "succeeded" && (
          <button disabled={phase === "downloading"} onClick={() => void download()}>
            MP4を保存
          </button>
        )}
        {job && terminal(job) && (
          <button onClick={() => void remove()}>サーバーから削除</button>
        )}
        {job?.state === "succeeded" && output && (
          <button
            onClick={() => {
              if (outputRef.current) URL.revokeObjectURL(outputRef.current);
              outputRef.current = "";
              setOutput("");
              setNote("保存先を確認してください。");
            }}
          >
            保存できました
          </button>
        )}
      </div>
      <details>
        <summary>この最小版の制限</summary>
        <p>
          1回の書き出しは{Math.floor(limits.maxFrames / 60)}秒まで、素材1本は
          {Math.floor(limits.maxUploadBytes / 1024 ** 2)}MiBまでです。完成物と素材は
          {session?.retentionHours ?? 24}
          時間後にサーバーから削除されます（残したい場合は早めに保存してください）。
          FNF書き出し、素材ライブラリへの保存、完了通知、自動再試行は未対応です。
          端末内の書き出しは従来どおり利用できます。
        </p>
      </details>
      <style>{`.cloud-export{border:1px solid #a58abe;border-radius:12px;padding:12px;margin:16px 0;overflow-wrap:anywhere}.cloud-export button,.cloud-export a{min-height:44px;padding:8px;margin:4px}.cloud-export progress{width:100%}.cloud-export-warning{background:#5a1f1f;color:#fff;padding:8px;border-radius:8px}.cloud-export-running{background:#1f3a5a;color:#fff;padding:8px;border-radius:8px}.cloud-export-actions{display:flex;gap:8px;flex-wrap:wrap}`}</style>
    </section>
  );
}
