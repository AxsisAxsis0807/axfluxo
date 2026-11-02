"use client";
import dynamic from "next/dynamic";
const CloudLibrary = dynamic(
  () => import("../../../features/developer/CloudLibrary"),
  {
    ssr: false,
    loading: () => <p role="status">クラウド素材を準備しています…</p>,
  },
);
export default function CloudLibraryPage() {
  return <CloudLibrary />;
}
