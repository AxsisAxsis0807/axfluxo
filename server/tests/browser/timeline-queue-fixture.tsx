import { LOCK_KEY } from "../../../src/services/developer/local-lock";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import LocalTimeline from "../../../src/features/developer/LocalTimeline";
import LocalVideoTool from "../../../src/features/developer/LocalVideoTool";
import ExportDock from "../../../src/features/video-common/ExportDock";
import { localExportQueue } from "../../../src/services/video/local-export-runtime";
import {
  SESSION_KEY,
  UNLOCK_MS,
} from "../../../src/services/developer/local-lock";
localStorage.setItem(
  LOCK_KEY,
  JSON.stringify({ salt: "a".repeat(32), hash: "b".repeat(64) }),
);
sessionStorage.setItem(SESSION_KEY, String(Date.now() + UNLOCK_MS));
Object.assign(window, { localExportQueue });
function Fixture() {
  const [file, setFile] = useState<File>(),
    [url, setUrl] = useState("");
  const [start, setStart] = useState(2),
    [end, setEnd] = useState(6),
    [mounted, setMounted] = useState(true);
  if (location.pathname.includes("queue"))
    return (
      <>
        <button onClick={() => setMounted((v) => !v)}>編集画面の開閉</button>
        {mounted && (
          <LocalVideoTool mode="fnf-showcase" ownerId="device-local" />
        )}
        <ExportDock />
      </>
    );
  return (
    <>
      <input
        aria-label="file"
        type="file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            setFile(f);
            setUrl(URL.createObjectURL(f));
          }
        }}
      />
      <label>
        開始
        <input
          aria-label="trim start"
          type="number"
          value={start}
          onChange={(e) => setStart(Number(e.target.value))}
        />
      </label>
      <label>
        終了
        <input
          aria-label="trim end"
          type="number"
          value={end}
          onChange={(e) => setEnd(Number(e.target.value))}
        />
      </label>
      <video id="media" src={url} controls playsInline />
      <button
        onClick={() => {
          void (document.getElementById("media") as HTMLVideoElement).play();
        }}
      >
        範囲を再生
      </button>
      {file && (
        <LocalTimeline
          file={file}
          duration={8}
          media={() => document.getElementById("media") as HTMLVideoElement}
          fnf={false}
          markers={[4e6]}
          items={[
            {
              id: "trim",
              startUs: start * 1e6,
              endUs: end * 1e6,
              label: "trim",
            },
          ]}
          onEdit={(_, a, b) => {
            setStart(a);
            setEnd(b);
          }}
        />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
