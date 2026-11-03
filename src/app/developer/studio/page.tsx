"use client";
import dynamic from "next/dynamic";
import DeveloperAccess from "../../../features/developer/DeveloperAccess";
const Editor = dynamic(
  () => import("../../../features/developer/DeveloperStudio"),
  { ssr: false, loading: () => <p role="status">準備しています…</p> },
);
export default function Page() {
  return (
    <DeveloperAccess
      title="Developer Studio"
      disabledMessage="開発者Studioの入口は停止中です。"
      enabled={process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED === "true"}
    >
      {({ api, services }) => <Editor api={api} services={services} />}
    </DeveloperAccess>
  );
}
