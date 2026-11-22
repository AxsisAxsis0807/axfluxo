"use client";
import { useEffect, useRef } from "react";

/** Keep at most one native media decoder alive. All Versions only needs audio:
 * it renders an independent cover image rather than source video frames. */
export default function LocalMediaPreview({
  id,
  url,
  audioOnly,
  warmMetadata,
  onError,
}: {
  id: string;
  url: string;
  audioOnly: boolean;
  warmMetadata: boolean;
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
      preload={warmMetadata ? "metadata" : "none"}
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
      preload={warmMetadata ? "metadata" : "none"}
      // Keep the original video-element EOF behavior: WebKit sometimes fires
      // a transient media error when seeking a PCM file to its final sample.
      // Destroying the element there loses the editor's exact cursor.
      style={{ width: "100%", maxHeight: 360 }}
      aria-label="素材動画プレビュー"
    />
  );
}
