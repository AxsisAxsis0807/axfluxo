"use client";
import dynamic from "next/dynamic";
const Editor = dynamic(() => import("../features/workspace/WorkspaceShell"), {
  ssr: false,
  loading: () => <div className="loading">AxFluxoを準備しています…</div>,
});
export default function Home() {
  return <Editor />;
}
