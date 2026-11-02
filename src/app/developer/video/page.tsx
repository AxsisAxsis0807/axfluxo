"use client";
import dynamic from "next/dynamic";
const DeveloperVideoPanel = dynamic(
  () => import("../../../features/video/DeveloperVideoPanel"),
  {
    ssr: false,
    loading: () => <p role="status">開発者画面を準備しています…</p>,
  },
);
export default function DeveloperVideoPage() {
  return <DeveloperVideoPanel />;
}
