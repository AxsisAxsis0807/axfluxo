"use client";
import dynamic from "next/dynamic";
import LocalDeveloperGate from "../../../features/developer/LocalDeveloperGate";
import IPhonePreviewDiagnostics from "../../../features/developer/IPhonePreviewDiagnostics";
const PreviewTool = dynamic(
  () => import("../../../features/developer/LocalVideoTool"),
  { ssr: false },
);
const LocalTool = dynamic(
  () => import("../../../features/developer/DeveloperTool"),
  { ssr: false },
);
export default function Page() {
  if (process.env.NEXT_PUBLIC_IPHONE_PREVIEW === "true")
    return (
      <LocalDeveloperGate preview>
        <p>PR #48 iPhone実機プレビュー · このサイト内の端末保存のみ</p>
        <IPhonePreviewDiagnostics />
        <PreviewTool mode="all-versions" ownerId="device-local" />
      </LocalDeveloperGate>
    );
  return (
    <LocalDeveloperGate>
      <LocalTool mode="all-versions" ownerId="device-local" />
    </LocalDeveloperGate>
  );
}
