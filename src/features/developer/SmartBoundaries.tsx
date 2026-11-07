"use client";
import { useEffect, useRef, useState } from "react";
import { analyzeTrackBoundaries } from "../../services/video/analyze-track-boundaries";
import {
  recommendedBoundary,
  type BoundaryPlacement,
  BOUNDARY_ALGORITHM,
  type BoundarySettings,
  sourceKey,
  type BoundaryAnalysis,
  type BoundaryCandidate,
} from "../../services/video/track-boundaries";
import { formatTime } from "../../services/video/time";
export default function SmartBoundaries({
  allowManualCandidate = false,
  onBusy,
  settings,
  onSettings,
  placement,
  onPlacement,
  file,
  duration,
  analysis,
  onChange,
  currentUs,
  onSeek,
  onApply,
  media,
  bounds,
}: {
  allowManualCandidate?: boolean;
  onBusy?: (busy: boolean) => void;
  settings: BoundarySettings;
  onSettings: (s: BoundarySettings) => void;
  placement: BoundaryPlacement;
  onPlacement: (p: BoundaryPlacement) => void;
  file: File;
  duration: number;
  analysis?: BoundaryAnalysis;
  onChange: (a: BoundaryAnalysis) => void;
  currentUs: number;
  onSeek: (us: number) => void;
  onApply: (us: number) => void;
  media: () => HTMLVideoElement | null;
  bounds: { startUs: number; endUs: number };
}) {
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    onBusy?.(progress !== null);
  }, [progress, onBusy]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [meter, setMeter] = useState(false);
  const [levels, setLevels] = useState<number[]>([]);
  const control = useRef<AbortController | null>(null);
  const audition = useRef<(() => void) | null>(null);
  const live = useRef(analysis);
  live.current = analysis;
  useEffect(
    () => () => {
      control.current?.abort();
      audition.current?.();
    },
    [file],
  );
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) {
        control.current?.abort();
        audition.current?.();
        setProgress(null);
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  const valid =
    analysis?.sourceKey === sourceKey(file) &&
    analysis.algorithm === BOUNDARY_ALGORITHM
      ? analysis
      : undefined;
  const candidates = (valid?.candidates ?? []).filter(
    (c) =>
      allowManualCandidate ||
      (c.startUs > bounds.startUs && c.endUs < bounds.endUs),
  );
  const at = (c: BoundaryCandidate) => recommendedBoundary(c, placement);
  async function run() {
    control.current?.abort();
    const abort = new AbortController();
    control.current = abort;
    setProgress(0);
    setError("");
    try {
      const result = await analyzeTrackBoundaries(
        file,
        duration,
        settings,
        abort.signal,
        setProgress,
      );
      if (abort.signal.aborted) return;
      const previous =
        live.current?.sourceKey === sourceKey(file) ? live.current : undefined;
      const deleted = previous?.deleted ?? [];
      onChange({
        complete: true,
        sourceKey: sourceKey(file),
        algorithm: BOUNDARY_ALGORITHM,
        settings,
        candidates: [
          ...result.candidates.filter((c) => !deleted.includes(c.id)),
          ...(previous?.candidates.filter((c) => c.reason === "manual") ?? []),
        ].sort((a, b) => a.timeUs - b.timeUs),
        deleted,
      });
      setLevels(result.levels);
    } catch (e) {
      if (!abort.signal.aborted)
        setError(
          `${e instanceof Error ? e.message : "解析に失敗しました。"} 素材を短く分割するか、対応形式に変換して再試行してください。既存の候補は保持しています。`,
        );
    } finally {
      if (control.current === abort) {
        control.current = null;
        setProgress(null);
      }
    }
  }
  const stopPreview = () => {
    audition.current?.();
    audition.current = null;
  };
  function preview(us: number) {
    stopPreview();
    const video = media();
    if (!video) return;
    const end = Math.min(bounds.endUs / 1e6, us / 1e6 + 2);
    onSeek(Math.max(bounds.startUs, us - 2e6));
    const stop = () => {
      video.pause();
      video.removeEventListener("timeupdate", update);
    };
    const update = () => {
      if (video.currentTime >= end) stop();
    };
    audition.current = stop;
    video.addEventListener("timeupdate", update);
    void video.play().catch(() => {
      stop();
      setError("再生ボタンを押してから試聴を再試行してください。");
    });
  }
  const db = levels[Math.floor(currentUs / 1e6 / 0.02)];
  return (
    <section aria-label="Smart Track Boundary Detection">
      <button
        disabled={progress !== null || !!valid?.complete}
        onClick={() => void run()}
      >
        曲間を自動検出
      </button>
      {valid && (
        <button disabled={progress !== null} onClick={() => void run()}>
          設定で再解析
        </button>
      )}
      {progress !== null && (
        <>
          <progress max={1} value={progress} />
          <output>{Math.floor(progress * 100)}%</output>
          <button
            onClick={() => {
              control.current?.abort();
              setProgress(null);
            }}
          >
            曲間解析をキャンセル
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>高度な解析設定</summary>
        <label>
          最短低音量（秒）
          <input
            type="number"
            min={0.1}
            step={0.02}
            value={settings.minimumGap}
            onChange={(e) =>
              onSettings({ ...settings, minimumGap: Number(e.target.value) })
            }
          />
        </label>
        <label>
          候補の最小間隔（秒）
          <input
            type="number"
            min={1}
            value={settings.minimumSpacing}
            onChange={(e) =>
              onSettings({
                ...settings,
                minimumSpacing: Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Version数（0：未指定）
          <input
            type="number"
            min={0}
            step={1}
            value={settings.expectedVersions}
            onChange={(e) =>
              onSettings({
                ...settings,
                expectedVersions: Number(e.target.value),
              })
            }
          />
        </label>
        <p>
          無音・低音量と前後の活動、周波数帯域の変化を調べます。曲中ブレイクも候補になるため試聴してください。信頼度は相対的な目安です。
        </p>
      </details>
      <label>
        推奨位置
        <select
          value={placement}
          onChange={(e) => onPlacement(e.target.value as BoundaryPlacement)}
        >
          <option value="middle">無音区間の中央</option>
          <option value="start">無音区間の開始</option>
          <option value="end">無音区間の終了</option>
          <option value="before">次の音声開始直前</option>
        </select>
      </label>
      <label>
        信頼度フィルター
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">すべて</option>
          <option value="medium">中以上</option>
          <option value="high">高のみ</option>
        </select>
      </label>
      {allowManualCandidate && (
        <button
          onClick={() =>
            onChange({
              sourceKey: sourceKey(file),
              algorithm: BOUNDARY_ALGORITHM,
              settings,
              complete: valid?.complete,
              deleted: valid?.deleted ?? [],
              candidates: [
                ...candidates,
                {
                  id: crypto.randomUUID(),
                  startUs: Math.round(currentUs),
                  endUs: Math.round(currentUs),
                  timeUs: Math.round(currentUs),
                  confidence: "low" as const,
                  reason: "manual" as const,
                },
              ].sort((a, b) => a.timeUs - b.timeUs),
            })
          }
        >
          中央に手動マーカー追加
        </button>
      )}
      <p>{candidates.length}件。候補の選択・移動では確定境界を変更しません。</p>
      <ol>
        {candidates
          .filter(
            (c) =>
              filter === "all" ||
              c.confidence === "high" ||
              (filter === "medium" && c.confidence === "medium"),
          )
          .map((c) => (
            <li key={c.id}>
              {formatTime(at(c))}｜
              {{ high: "高", medium: "中", low: "低" }[c.confidence]}信頼度（
              {c.reason}）
              <small>
                {" "}
                {formatTime(c.startUs)}〜{formatTime(c.endUs)}
              </small>
              <button
                onClick={() => {
                  stopPreview();
                  onSeek(at(c));
                }}
              >
                移動
              </button>
              <button
                disabled={at(c) < bounds.startUs || at(c) > bounds.endUs}
                onClick={() => preview(at(c))}
              >
                試聴
              </button>
              <button onClick={() => onApply(at(c))}>境界として適用</button>
              <button
                onClick={() => {
                  stopPreview();
                  onChange({
                    ...valid!,
                    candidates: valid!.candidates.filter((v) => v.id !== c.id),
                    deleted: [...(valid?.deleted ?? []), c.id],
                  });
                }}
              >
                削除
              </button>
            </li>
          ))}
      </ol>
      <button onClick={stopPreview}>試聴停止</button>
      <label>
        <input
          type="checkbox"
          checked={meter}
          onChange={(e) => setMeter(e.target.checked)}
        />
        音量メーター
      </label>
      {meter && (
        <p>
          <meter min={-120} max={0} value={db ?? -120} />
          <output>
            {db === undefined
              ? "解析後に現在位置のRMSを表示"
              : db <= -120
                ? "無音"
                : `${db.toFixed(1)} dBFS`}
          </output>
          （デジタル基準。スピーカー音量とは異なります）
        </p>
      )}
    </section>
  );
}
