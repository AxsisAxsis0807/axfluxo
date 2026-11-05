"use client";
import { useRef, useState } from "react";
import {
  recorderType,
  type LocalEncodeJob,
} from "../../services/video/local-encode";
import {
  allowExportAudio,
  localExportQueue,
  releaseIdleExportAudio,
} from "../../services/video/local-export-runtime";
export function LocalExport({
  prepare,
  disabled,
  rest: savedRest,
  onRestChange,
}: {
  prepare: () => Promise<LocalEncodeJob[]>;
  disabled: boolean;
  rest?: boolean;
  onRestChange?: (rest: boolean) => void;
}) {
  const adding = useRef(false);
  const [localRest, setRest] = useState(true),
    [preparing, setPreparing] = useState(false),
    [status, setStatus] = useState("");
  const rest = savedRest ?? localRest;
  async function add() {
    if (adding.current) return;
    adding.current = true;
    setPreparing(true);
    setStatus("入力内容と出力形式を確認しています…");
    try {
      if (!recorderType())
        throw Error(
          "このSafari／ブラウザーは対応するMP4・WebM出力形式を利用できません。別の対応ブラウザーでお試しください。",
        );
      if (typeof HTMLCanvasElement.prototype.captureStream !== "function")
        throw Error("このブラウザーはCanvasの動画書き出しに対応していません。");
      // Called during the tap, before cover loading or storage awaits.
      void allowExportAudio().catch(() =>
        setStatus("下部の詳細から音声処理を許可してください。"),
      );
      const snapshot = prepare();
      localExportQueue.enqueue(await snapshot, rest);
      setStatus(
        "現在の設定で予約しました。下部の書き出しキューで確認できます。",
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "予約できません。");
    } finally {
      adding.current = false;
      setPreparing(false);
      releaseIdleExportAudio();
    }
  }
  return (
    <section aria-label="端末内書き出し">
      <h2>端末内エンコード（標準）</h2>
      <p>
        予約した設定で1件ずつ自動処理します。編集中の変更は既存の予約に反映されません。書き出しは再生時間程度かかります。対応端末ではMP4、その他はWebMで保存します。
      </p>
      <label>
        <input
          type="checkbox"
          checked={rest}
          onChange={(e) => {
            setRest(e.target.checked);
            onRestChange?.(e.target.checked);
          }}
        />
        10分処理・4分休憩モード
      </label>
      <p>
        休憩モードは温度の安全性を保証しません。負荷が高い場合はプレビューを一時停止してください。
      </p>
      <button disabled={disabled || preparing} onClick={() => void add()}>
        {preparing ? "予約を準備中…" : "端末内で書き出す"}
      </button>
      <p role="status">{status}</p>
    </section>
  );
}
