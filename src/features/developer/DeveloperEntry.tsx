"use client";
import { useDeveloperAccess } from "./useDeveloperAccess";
export default function DeveloperEntry() {
  const enabled = process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED === "true",
    access = useDeveloperAccess(enabled);
  if (!enabled || access.state !== "ready") return null;
  return (
    <nav aria-label="開発者向け">
      <a
        style={{
          display: "inline-flex",
          alignItems: "center",
          minHeight: 44,
          padding: 12,
          overflowWrap: "anywhere",
        }}
        href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/developer/studio/`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Developer Studioを別タブで開く
      </a>
    </nav>
  );
}
