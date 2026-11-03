"use client";
import { useEffect, useState } from "react";
import {
  createVideoApiClient,
  currentVideoSessionSource,
} from "../../services/video/api-client";
/** Navigation follows server membership checks; a build flag grants no authority. */
export default function DeveloperStudioLink() {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const session = currentVideoSessionSource(),
      baseUrl =
        process.env.NEXT_PUBLIC_DEVELOPER_AUTH_API_ORIGIN ??
        process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
    if (!session || !baseUrl) return;
    let live = true;
    try {
      void createVideoApiClient({ session, baseUrl })
        .me()
        .then((r) => {
          if (live) setAllowed(r.ok);
        });
    } catch {}
    return () => {
      live = false;
    };
  }, []);
  return allowed ? (
    <a
      href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/developer/studio/`}
      target="_blank"
      rel="noopener noreferrer"
    >
      開発者Studioを別タブで開く
    </a>
  ) : null;
}
