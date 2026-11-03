"use client";
import dynamic from "next/dynamic";
import { DeveloperVideoStatus } from "../../../features/video/DeveloperVideoStatus";
import DeveloperAccess from "../../../features/developer/DeveloperAccess";
const Editor = dynamic(
  () => import("../../../features/video/DeveloperVideoPanel"),
  { ssr: false, loading: () => <p role="status">準備しています…</p> },
);
export default function Page() {
  if (process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED !== "true")
    return (
      <main style={{ padding: 24 }}>
        <h1>開発者用動画ジョブ</h1>
        <DeveloperVideoStatus state="held" />
        <p>
          {process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN
            ? "新しい動画入口は停止中です。APIへ接続していません。"
            : "開発者APIは未設定です。"}
        </p>
        <a href={process.env.NEXT_PUBLIC_BASE_PATH || "/"}>
          制作画面・ログインへ戻る
        </a>
      </main>
    );
  return (
    <DeveloperAccess
      title="開発者用動画ジョブ"
      disabledMessage="開発者APIは未設定です。"
      enabled={process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED === "true"}
    >
      {({ api }) => <Editor client={api} />}
    </DeveloperAccess>
  );
}
