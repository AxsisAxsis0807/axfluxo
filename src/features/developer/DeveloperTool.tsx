"use client";
import { DeveloperGate } from "./DeveloperAccess";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import LocalVideoTool from "./LocalVideoTool";
import {
  createVideoApiClient,
  currentVideoSessionSource,
} from "../../services/video/api-client";
const AllVersions = dynamic(() => import("../all-versions/AllVersionsEditor"), {
  ssr: false,
});
const Fnf = dynamic(() => import("../fnf-showcase/FnfShowcaseEditor"), {
  ssr: false,
});
export default function DeveloperTool({
  mode,
  ownerId,
}: {
  mode: "all-versions" | "fnf-showcase";
  ownerId: string;
}) {
  const [opened, setOpened] = useState(false);
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
    <>
      <LocalVideoTool mode={mode} ownerId={ownerId} />
      {!api && (
        <p>
          クラウド機能は動画APIまたはログインが未設定のため利用できません。端末内制作は利用できます。
        </p>
      )}
      {api && (
        <details
          onToggle={(e) => {
            if (e.currentTarget.open) setOpened(true);
          }}
        >
          <summary style={{ minHeight: 44, padding: 12 }}>
            既存のクラウド素材・サーバー書き出しを開く
          </summary>
          <p>この追加機能には動画API側の開発者登録も必要です。</p>
          {opened && (
            <DeveloperGate>
              {() =>
                mode === "all-versions" ? (
                  <AllVersions api={api} />
                ) : (
                  <Fnf api={api} />
                )
              }
            </DeveloperGate>
          )}
        </details>
      )}
    </>
  );
}
