"use client";
import dynamic from "next/dynamic";
import DeveloperAccess from "../../../features/developer/DeveloperAccess";
const Editor = dynamic(
  () => import("../../../features/developer/CloudLibrary"),
  { ssr: false, loading: () => <p role="status">準備しています…</p> },
);
export default function Page() {
  return (
    <DeveloperAccess
      title="開発者クラウド素材"
      disabledMessage="クラウド素材APIは未設定です。"
      enabled={process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED === "true"}
    >
      {({ api, services }) =>
        services.cloudLibrary ? (
          <Editor auth={api} uploadsEnabled={services.uploads} />
        ) : (
          <p role="status">クラウド素材APIは未準備です。</p>
        )
      }
    </DeveloperAccess>
  );
}
