"use client";
import { useState, useSyncExternalStore } from "react";
import {
  getEncodeReport,
  subscribeEncodeReport,
} from "../../services/video/local-encode-diagnostics";
import { recorderType } from "../../services/video/local-encode";

function browserDescription() {
  // Keep browser family and major version only. Never include full UA or URLs.
  const ua = navigator.userAgent;
  const match =
    /(?:CriOS|Chrome)\/(\d+)/.exec(ua) ??
    /(?:FxiOS|Firefox)\/(\d+)/.exec(ua) ??
    /Version\/(\d+).*Safari/.exec(ua);
  if (!match) return "その他";
  const family = match[0].split("/")[0];
  return `${family === "Version" ? "Safari" : family} ${match[1]}`;
}
export default function IPhonePreviewDiagnostics() {
  const attempt = useSyncExternalStore(
    subscribeEncodeReport,
    getEncodeReport,
    () => null,
  );
  const [open, setOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const info = open
    ? JSON.stringify(
        {
          browser: browserDescription(),
          secureContext: window.isSecureContext,
          videoEncoder: typeof VideoEncoder !== "undefined",
          audioEncoder: typeof AudioEncoder !== "undefined",
          audioDecoder: typeof AudioDecoder !== "undefined",
          offlineAudioContext: typeof OfflineAudioContext !== "undefined",
          mediaRecorder: recorderType(),
          canvasCapture:
            typeof HTMLCanvasElement.prototype.captureStream === "function",
          attempt,
        },
        null,
        2,
      )
    : "";
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary style={{ minHeight: 44 }}>書き出し診断</summary>
      {open && (
        <>
          <textarea
            aria-label="診断情報"
            readOnly
            value={info}
            rows={12}
            style={{ width: "100%", fontSize: 16, boxSizing: "border-box" }}
          />
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(info);
                setCopyStatus("コピーしました。");
              } catch {
                setCopyStatus("診断情報を選択してコピーしてください。");
              }
            }}
          >
            診断をコピー
          </button>
          <span role="status">{copyStatus}</span>
        </>
      )}
    </details>
  );
}
