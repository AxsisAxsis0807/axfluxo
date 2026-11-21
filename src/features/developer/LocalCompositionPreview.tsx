"use client";
import { useEffect, useRef, useState } from "react";
import type { LocalEncodeJob } from "../../services/video/local-encode";
export default function LocalCompositionPreview({
  job,
}: {
  job: LocalEncodeJob;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    video = useRef<HTMLMediaElement | null>(null),
    continuing = useRef(false);
  const [index, setIndex] = useState(0),
    [source, setSource] = useState<{
      job: LocalEncodeJob;
      index: number;
      url: string;
    }>(),
    [message, setMessage] = useState("");
  const selectedIndex = Math.min(index, job.pieces.length - 1);
  const piece = job.pieces[selectedIndex];
  const url =
    source?.job === job && source.index === selectedIndex
      ? source.url
      : undefined;
  const sequential = job.pieces.some(({ kind }) => kind === "audio");
  useEffect(() => {
    let live = true;
    void job.pieces[selectedIndex].url().then(
      (value) => {
        if (live) setSource({ job, index: selectedIndex, url: value });
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
    let frame = 0;
    const draw = () => {
      const ctx = canvas.current?.getContext("2d"),
        media = video.current;
      if (ctx && media && media.readyState >= 2) {
        const piece = job.pieces[selectedIndex],
          offset = job.pieces
            .slice(0, selectedIndex)
            .reduce((sum, p) => sum + p.end - p.start, 0);
        const seconds = offset + Math.max(0, media.currentTime - piece.start);
        if (media instanceof HTMLVideoElement) job.draw(ctx, media, seconds);
        else job.drawAudio?.(ctx, seconds);
        if (media.currentTime >= piece.end && (!media.paused || media.ended)) {
          media.pause();
          if (
            sequential &&
            selectedIndex + 1 < job.pieces.length &&
            !continuing.current
          ) {
            continuing.current = true;
            setIndex(selectedIndex + 1);
          } else {
            setMessage("区間の再生が完了しました。次の素材を選択できます。");
          }
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [job, selectedIndex, sequential]);
  const Media = piece.kind === "audio" ? "audio" : "video";
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
      <Media
        key={`${url}:${job.pieces[selectedIndex].start}:${job.pieces[selectedIndex].end}`}
        ref={(media) => {
          video.current = media;
        }}
        src={url}
        controls
        playsInline={piece.kind !== "audio"}
        onPlay={({ currentTarget: media }) => {
          if (media.currentTime < piece.start || media.currentTime >= piece.end)
            media.currentTime = piece.start;
        }}
        onLoadedMetadata={(e) => {
          const media = e.currentTarget;
          media.currentTime = piece.start;
          if (continuing.current) {
            continuing.current = false;
            void media
              .play()
              .catch(() =>
                setMessage(
                  "次のバージョンを再生するには再生ボタンを押してください。",
                ),
              );
          }
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
          onChange={(e) => {
            continuing.current = false;
            setIndex(Number(e.target.value));
          }}
        >
          {job.pieces.map((item, i) => (
            <option key={i} value={i}>
              {item.name ?? `素材 ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
      <p role="status">{message}</p>
    </section>
  );
}
