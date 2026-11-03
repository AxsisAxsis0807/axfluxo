"use client";
import dynamic from "next/dynamic";
import DeveloperAccess from "../../../features/developer/DeveloperAccess";
const Editor = dynamic(
  () => import("../../../features/all-versions/AllVersionsEditor"),
  { ssr: false, loading: () => <p role="status">準備しています…</p> },
);
export default function Page() {
  return (
    <DeveloperAccess
      title="All Versions"
      disabledMessage="入口はOFFです。projectと原本は保持されています。"
      enabled={
        process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED === "true" &&
        process.env.NEXT_PUBLIC_ALL_VERSIONS_ENABLED === "true"
      }
    >
      {({ api, services }) => <Editor api={api} services={services} />}
    </DeveloperAccess>
  );
}
