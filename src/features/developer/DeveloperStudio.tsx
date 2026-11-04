"use client";
import Link from "next/link";
import { DeveloperGate } from "./DeveloperAccess";
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
  return (
    <main style={{ maxWidth: 960, margin: "auto", padding: 16 }}>
      <h1>Developer Studio</h1>
      <p>動画APIの設定なしで、端末の素材から動画を制作・書き出しできます。</p>
      <nav aria-label="動画ツール">
        <p>
          <Link
            style={{ display: "inline-block", padding: 12, minHeight: 44 }}
            href="/developer/all-versions/"
          >
            All Versions Video Maker
          </Link>
        </p>
        <p>
          <Link
            style={{ display: "inline-block", padding: 12, minHeight: 44 }}
            href="/developer/fnf-showcase/"
          >
            FNF Showcase Maker
          </Link>
        </p>
      </nav>
      <p>端末内エンコード・10分処理／4分休憩に対応しています。</p>
      {!api && (
        <p>
          クラウド機能は動画APIまたはログインが未設定のため利用できません。端末内制作は利用できます。
        </p>
      )}
      {api && (
        <>
          <button onClick={() => setCloud((v) => !v)} style={{ minHeight: 44 }}>
            クラウドの完成動画を表示／閉じる
          </button>
          {cloud && (
            <DeveloperGate>{() => <Library api={api} />}</DeveloperGate>
          )}
        </>
      )}
    </main>
  );
}
