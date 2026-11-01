"use client";
import dynamic from "next/dynamic";
const PreviewWorkspace = dynamic(
  () => import("../../../features/video-common/PreviewWorkspace"),
  { ssr: false, loading: () => <p role="status">previewを準備しています…</p> },
);
export default function VideoPreviewPage() {
  return <PreviewWorkspace />;
}
