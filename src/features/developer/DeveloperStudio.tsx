"use client";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import {
  createVideoApiClient,
  currentVideoSessionSource,
} from "../../services/video/api-client";
const Library = dynamic(() => import("./OutputLibrary"), { ssr: false });
export default function DeveloperStudio() {
  const [cloud, setCloud] = useState(false);
  const api = useMemo(() => {
    const baseUrl = process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN,
      session = currentVideoSessionSource();
    if (!baseUrl || !session) return null;
    try {
      return createVideoApiClient({ baseUrl, session });
    } catch {
      return null;
    }
  }, []);
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  return (
    <main style={{ maxWidth: 960, margin: "auto", padding: 16 }}>
      <h1>Developer Studio</h1>
      <p>動画APIの設定なしで、端末の素材から動画を制作・書き出しできます。</p>
      <nav aria-label="動画ツール">
        <p>
          <a
            style={{ display: "inline-block", padding: 12, minHeight: 44 }}
            href={`${base}/developer/all-versions/`}
          >
            All Versions Video Maker
          </a>
        </p>
        <p>
          <a
            style={{ display: "inline-block", padding: 12, minHeight: 44 }}
            href={`${base}/developer/fnf-showcase/`}
          >
            FNF Showcase Maker
          </a>
        </p>
      </nav>
      <p>端末内エンコード・10分処理／4分休憩に対応しています。</p>
      {api && (
        <>
          <button onClick={() => setCloud((v) => !v)} style={{ minHeight: 44 }}>
            クラウドの完成動画を表示／閉じる
          </button>
          {cloud && <Library api={api} />}
        </>
      )}
    </main>
  );
}
