"use client";
import dynamic from "next/dynamic";
import { useEffect } from "react";
const Account = dynamic(() => import("../../../features/auth/Account"), {
  ssr: false,
});
const Studio = dynamic(
  () => import("../../../features/developer/OutputLibrary"),
  { ssr: false },
);
export default function Page() {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED !== "true") return;
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/developer.webmanifest`;
    document.head.append(link);
    return () => link.remove();
  }, []);
  return (
    <>
      {process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED === "true" && (
        <Account />
      )}
      <Studio />
    </>
  );
}
