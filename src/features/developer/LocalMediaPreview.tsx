"use client";
import { useEffect, useRef } from "react";

/** Only mount a native decoder while the user is actively inspecting this source.
 * Keep the shared object URL alive for timeline edits and the export queue. */
export default function LocalMediaPreview({
  id,
  url,
  onError,
}: {
  id: string;
  url: string;
  onError: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    return () => {
      if (!element) return;
      // Removing the source AND calling load() releases Safari's media pipeline.
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [url]);
  return (
    <video
      ref={video}
      id={`local-media-${id}`}
      src={url}
      controls
      playsInline
      preload="none"
      onError={onError}
      style={{ width: "100%", maxHeight: 360 }}
      aria-label="素材プレビュー"
    />
  );
}
