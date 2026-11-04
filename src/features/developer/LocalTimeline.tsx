"use client";
import { useEffect, useState } from "react";
import { Timeline, type TimelineItem } from "../video-common/Timeline";
import { useLocalWaveform } from "../video-common/useLocalWaveform";
export default function LocalTimeline({
  file,
  duration,
  media,
  items,
  markers,
  fnf,
  onEdit,
}: {
  file: File;
  duration: number;
  media: () => HTMLVideoElement | null;
  items: TimelineItem[];
  markers: number[];
  fnf: boolean;
  onEdit: (id: string, start: number, end: number) => void;
}) {
  const [current, setCurrent] = useState(0);
  const analysis = useLocalWaveform(file, duration);
  useEffect(() => {
    const video = media();
    if (!video) return;
    const update = () => setCurrent(video.currentTime * 1e6);
    video.addEventListener("timeupdate", update);
    return () => video.removeEventListener("timeupdate", update);
  }, [media]);
  const busy = analysis.status === "queued" || analysis.status === "analyzing";
  const messages = {
    queued: "音声波形の解析待ち…",
    analyzing: `音声波形を解析中 ${Math.floor(analysis.progress * 100)}%（編集できます）`,
    complete: "音声波形の解析完了",
    "no-audio": "音声トラックがありません。",
    cancelled: "波形解析をキャンセルしました。編集・書き出しは利用できます。",
    paused: "画面の中断により波形解析を停止しました。再解析できます。",
    failed:
      "この素材の音声形式を端末で解析できません。編集・書き出しは利用できます。",
  };
  return (
    <section aria-label="素材のタイムライン">
      <p role="status">
        {messages[analysis.status]}{" "}
        {analysis.status === "failed" ? analysis.reason : ""}
      </p>
      {busy && (
        <button type="button" onClick={analysis.cancel}>
          波形解析をキャンセル
        </button>
      )}
      {["cancelled", "paused", "failed"].includes(analysis.status) && (
        <button type="button" onClick={analysis.retry}>
          波形を再解析
        </button>
      )}
      <Timeline
        mode={fnf ? "fnf" : "all-versions"}
        durationUs={Math.round(duration * 1e6)}
        currentUs={current}
        items={items}
        markers={markers}
        waveform={
          analysis.waveform
            ? {
                ...analysis.waveform,
                clipStartUs: 0,
                clipEndUs: analysis.analyzedUntilUs,
              }
            : undefined
        }
        onSeek={(us) => {
          const video = media();
          if (video) video.currentTime = us / 1e6;
          setCurrent(us);
        }}
        onEdit={(id, start, end) => onEdit(id, start / 1e6, end / 1e6)}
      />
    </section>
  );
}
