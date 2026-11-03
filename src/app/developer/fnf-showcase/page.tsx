"use client";
import dynamic from "next/dynamic";
import DeveloperAccess from "../../../features/developer/DeveloperAccess";
const Editor = dynamic(
  () => import("../../../features/fnf-showcase/FnfShowcaseEditor"),
  { ssr: false, loading: () => <p role="status">準備しています…</p> },
);
export default function Page() {
  return (
    <DeveloperAccess
      title="FNF Showcase Maker"
      disabledMessage="入口はOFFです。受付jobと完成物は保持されています。"
      enabled={
        process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED === "true" &&
        process.env.NEXT_PUBLIC_FNF_SHOWCASE_ENABLED === "true"
      }
    >
      {({ api, services }) => <Editor api={api} services={services} />}
    </DeveloperAccess>
  );
}
