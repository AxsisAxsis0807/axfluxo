"use client";
import dynamic from "next/dynamic";
import DeveloperAccess from "../../../features/developer/DeveloperAccess";
const Editor = dynamic(
  () => import("../../../features/video-common/PreviewWorkspace"),
  { ssr: false, loading: () => <p role="status">準備しています…</p> },
);
export default function Page() {
  return (
    <DeveloperAccess
      title="動画preview・非破壊trim"
      disabledMessage="新しいpreview入口は無効です。"
      enabled={
        process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED === "true" &&
        process.env.NEXT_PUBLIC_VIDEO_PREVIEW_ENABLED === "true"
      }
    >
      {({ services }) =>
        services.preview ? (
          <Editor />
        ) : (
          <p role="status">preview APIは未準備です。</p>
        )
      }
    </DeveloperAccess>
  );
}
