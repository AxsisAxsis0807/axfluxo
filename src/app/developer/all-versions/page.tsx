"use client";
import dynamic from "next/dynamic";
const Editor = dynamic(
  () => import("../../../features/all-versions/AllVersionsEditor"),
  { ssr: false, loading: () => <p>All Versionsを準備しています…</p> },
);
export default function Page() {
  return <Editor />;
}
