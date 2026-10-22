"use client";
import dynamic from "next/dynamic";
const Editor = dynamic(() => import("../features/editor/Editor"), {
  ssr: false,
  loading: () => <div className="loading">AxFluxo Studioを準備しています…</div>,
});
export default function Home() {
  return <Editor />;
}
