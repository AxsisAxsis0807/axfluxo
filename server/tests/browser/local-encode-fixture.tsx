import { LOCK_KEY } from "../../../src/services/developer/local-lock";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { LocalExport } from "../../../src/features/video-common/LocalExport";
import ExportDock from "../../../src/features/video-common/ExportDock";
import { allowExportAudio, localExportQueue, reserveLocalExports } from "../../../src/services/video/local-export-runtime";
import { recorderType, type LocalEncodeJob } from "../../../src/services/video/local-encode";
import {
  SESSION_KEY,
  UNLOCK_MS,
} from "../../../src/services/developer/local-lock";
localStorage.setItem(
  LOCK_KEY,
  JSON.stringify({ salt: "a".repeat(32), hash: "b".repeat(64) }),
);
sessionStorage.setItem(SESSION_KEY, String(Date.now() + UNLOCK_MS));
// These synthetic legacy-recorder jobs deliberately exercise a custom 320x180
// draw and both gap values. Neither production recipe describes that output.
// Keep the low-level codec harness isolated from durable reservation, and
// independently verify that the public reservation API rejects the raw job.
function rawJob(): LocalEncodeJob {
  return {
    filename: "encoded.mp4",
    gapBetweenPiecesSeconds: location.hash === "#gap" ? 1 : 0,
    width: 320,
    height: 180,
    pieces: [
      { url: async () => "https://encode.test/source.mp4", start: 0.2, end: 0.7 },
      { url: async () => "https://encode.test/source.mp4", start: 0.1, end: 0.6 },
    ],
    draw: (ctx, media) => ctx.drawImage(media, 0, 0, 320, 180),
  };
}
function LegacyHarness() {
  const [status, setStatus] = useState("");
  const [rest, setRest] = useState(true);
  if (location.hash === "#reject")
    return <><button onClick={async () => {
      try {
        await reserveLocalExports([rawJob()], true);
        setStatus("Unexpected reservation");
      } catch (error) {
        setStatus(String(error));
      }
    }}>復旧設定なしの予約を検査</button><p role="status">{status}</p></>;
  // Keep the real LocalExport unsupported-browser check under test.
  if (!recorderType() || typeof HTMLCanvasElement.prototype.captureStream !== "function")
    return <LocalExport disabled={false} prepare={async () => [rawJob()]} />;
  return <section aria-label="legacy encoder test harness">
    <label><input type="checkbox" checked={rest} onChange={e => setRest(e.currentTarget.checked)} />10分処理・4分休憩モード</label>
    <button onClick={() => {
      void allowExportAudio().catch(error => setStatus(String(error)));
      localExportQueue.enqueue([rawJob()], rest);
      setStatus("低レベルエンコーダー検査を開始");
    }}>端末内で書き出す</button>
    <p role="status">{status}</p>
  </section>;
}
createRoot(document.getElementById("root")!).render(<><LegacyHarness /><ExportDock /></>);
