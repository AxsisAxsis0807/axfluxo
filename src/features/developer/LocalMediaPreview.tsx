"use client";
import { useEffect, useRef } from "react";

/** Keep at most one native media decoder alive. All Versions only needs audio:
 * it renders an independent cover image rather than source video frames. */
export default function LocalMediaPreview({
  id,
  url,
  audioOnly,
  onError,
}: {
  id: string;
  url: string;
  audioOnly: boolean;
  onError: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = audioOnly ? audio.current : video.current;
    return () => {
      if (!element) return;
      // Keep the File URL for editing/export, but release native media state.
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [url, audioOnly]);
  return audioOnly ? (
    <audio
      ref={audio}
      id={`local-media-${id}`}
      src={url}
      controls
      preload="none"
      onError={onError}
      style={{ width: "100%" }}
      aria-label="素材音声プレビュー"
    />
  ) : (
    <video
      ref={video}
      id={`local-media-${id}`}
      src={url}
      controls
      playsInline
      preload="none"
      onError={onError}
      style={{ width: "100%", maxHeight: 360 }}
      aria-label="素材動画プレビュー"
    />
  );
}
