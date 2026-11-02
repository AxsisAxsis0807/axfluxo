"use client";
import dynamic from "next/dynamic";
const Editor = dynamic(
  () => import("../../../features/fnf-showcase/FnfShowcaseEditor"),
  { ssr: false, loading: () => <p>FNF Showcaseを準備しています…</p> },
);
export default function Page() {
  return <Editor />;
}
