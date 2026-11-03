"use client";
import { useEffect, useRef, useState } from "react";
import {
  encodeLocal,
  recorderType,
  type LocalEncodeJob,
} from "../../services/video/local-encode";
export function LocalExport({
  prepare,
  disabled,
}: {
  prepare: () => Promise<LocalEncodeJob[]>;
  disabled: boolean;
}) {
  const [rest, setRest] = useState(true),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  const [files, setFiles] = useState<{ url: string; filename: string }[]>([]);
  const abort = useRef<AbortController | null>(null),
    urls = useRef<string[]>([]);
  useEffect(() => {
    const allocatedUrls = urls.current;
    const hidden = () => {
      if (document.hidden)
        abort.current?.abort(
          Error(
            "画面が非表示になったため停止しました。Safariを前面にして再試行してください。",
          ),
        );
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      abort.current?.abort();
      allocatedUrls.forEach(URL.revokeObjectURL);
    };
  }, []);
  async function run() {
    if (abort.current) return;
    if (!recorderType()) {
      setStatus("このブラウザーは端末内エンコードに対応していません。");
      return;
    }
    const control = new AbortController();
    abort.current = control;
    setBusy(true);
    setStatus("素材を準備しています…");
    let audio: AudioContext | undefined;
    try {
      audio = new AudioContext();
      await audio.resume();
      const budget = { processing: 0 };
      for (const job of await prepare()) {
        control.signal.throwIfAborted();
        const result = await encodeLocal(
          job,
          audio,
          control.signal,
          rest,
          budget,
          setStatus,
        );
        const url = URL.createObjectURL(result.blob);
        urls.current.push(url);
        setFiles((old) => [...old, { url, filename: result.filename }]);
      }
      setStatus("端末内エンコードが完了しました。各動画を保存してください。");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "処理を停止しました。");
    } finally {
      await audio?.close().catch(() => {});
      abort.current = null;
      setBusy(false);
    }
  }
  return (
    <section aria-label="端末内書き出し">
      <h2>端末内エンコード（標準）</h2>
      <p>
        休憩モードは温度の安全性を保証しません。Safariを前面にしたまま処理してください。書き出しは再生時間程度かかります。対応端末ではMP4、その他はWebMで保存します。
      </p>
      <label>
        <input
          type="checkbox"
          checked={rest}
          disabled={busy}
          onChange={(e) => setRest(e.target.checked)}
        />
        10分処理・4分休憩モード
      </label>
      <button disabled={disabled || busy} onClick={() => void run()}>
        端末内で書き出す
      </button>
      {busy && (
        <button
          onClick={() => abort.current?.abort(Error("処理を中止しました。"))}
        >
          中止
        </button>
      )}
      <p role="status">{status}</p>
      <p>
        保存リンクからFilesへ保存できます。MP4はFilesの共有メニューから「ビデオを保存」を選び、写真アプリで確認してください。WebMは端末によって写真へ保存できません。完成ファイルはこの画面を閉じる前に保存してください。
      </p>
      {files.map((f) => (
        <p key={f.url}>
          <a
            href={f.url}
            download={f.filename}
            style={{ display: "inline-block", minHeight: 44, padding: 12 }}
          >
            {f.filename}を保存
          </a>
        </p>
      ))}
    </section>
  );
}
