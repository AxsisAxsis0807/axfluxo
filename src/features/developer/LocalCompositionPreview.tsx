"use client";
import { useEffect, useRef, useState } from "react";
import type { LocalEncodeJob } from "../../services/video/local-encode";
export default function LocalCompositionPreview({
  job,
}: {
  job: LocalEncodeJob;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    video = useRef<HTMLVideoElement>(null);
  const [index, setIndex] = useState(0),
    [url, setUrl] = useState(""),
    [message, setMessage] = useState("");
  const selectedIndex = Math.min(index, job.pieces.length - 1);
  useEffect(() => {
    let live = true;
    void job.pieces[selectedIndex].url().then(
      (value) => {
        if (live) setUrl(value);
      },
      () => {
        if (live) setMessage("素材を開けません。");
      },
    );
    return () => {
      live = false;
    };
  }, [job, selectedIndex]);
  useEffect(() => {
    const media = video.current;
    if (!media) return;
    let frame = 0;
    const draw = () => {
      if (document.hidden) return;
      const ctx = canvas.current?.getContext("2d");
      if (ctx && media.readyState >= 2) {
        const piece = job.pieces[selectedIndex],
          offset = job.pieces
            .slice(0, selectedIndex)
            .reduce((sum, p) => sum + p.end - p.start, 0);
        job.draw(
          ctx,
          media,
          offset + Math.max(0, media.currentTime - piece.start),
        );
        if (media.currentTime >= piece.end && !media.paused) {
          media.pause();
          setMessage("区間の再生が完了しました。次の素材を選択できます。");
        }
      }
      // No constant canvas work while paused or on a background tab.
      if (!media.paused && !document.hidden) frame = requestAnimationFrame(draw);
    };
    const once = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!document.hidden) once();
    };
    const hidden = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        media.pause();
      }
    };
    media.addEventListener("play", once);
    media.addEventListener("pause", stop);
    media.addEventListener("loadeddata", once);
    media.addEventListener("seeked", once);
    document.addEventListener("visibilitychange", hidden);
    once();
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener("play", once);
      media.removeEventListener("pause", stop);
      media.removeEventListener("loadeddata", once);
      media.removeEventListener("seeked", once);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [job, selectedIndex, url]);
  useEffect(() => {
    const media = video.current;
    return () => {
      if (!media) return;
      media.pause();
      media.removeAttribute("src");
      media.load();
    };
  }, [url, selectedIndex]);
  return (
    <section aria-label="合成プレビュー">
      <h2>合成プレビュー</h2>
      <canvas
        ref={canvas}
        width={job.width}
        height={job.height}
        style={{
          width: "100%",
          maxHeight: 480,
          objectFit: "contain",
          background: "black",
        }}
      />
      <video
        key={`${url}:${job.pieces[selectedIndex].start}:${job.pieces[selectedIndex].end}`}
        ref={video}
        src={url}
        controls
        playsInline
        onLoadedMetadata={(e) => {
          e.currentTarget.currentTime = job.pieces[selectedIndex].start;
        }}
        onError={() =>
          setMessage("プレビューを再生できません。素材形式を確認してください。")
        }
        style={{ width: "100%", maxHeight: 120 }}
      />
      <p>
        音声・再生操作は上のコントロールを使用します。合成結果はキャンバスに表示されます。
      </p>
      <label>
        プレビューする素材
        <select
          value={selectedIndex}
          onChange={(e) => setIndex(Number(e.target.value))}
        >
          {job.pieces.map((_, i) => (
            <option key={i} value={i}>
              素材 {i + 1}
            </option>
          ))}
        </select>
      </label>
      <p role="status">{message}</p>
    </section>
  );
}
