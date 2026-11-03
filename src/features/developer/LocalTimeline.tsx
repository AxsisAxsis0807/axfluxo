"use client";
import { useEffect, useState } from "react";
import { Timeline, type TimelineItem } from "../video-common/Timeline";
import type { Waveform } from "../../domain/video/preview";
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
  const [current, setCurrent] = useState(0),
    [waveform, setWaveform] = useState<Waveform>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const video = media();
    if (!video) return;
    const update = () => setCurrent(video.currentTime * 1e6);
    video.addEventListener("timeupdate", update);
    return () => video.removeEventListener("timeupdate", update);
  }, [media]);
  async function wave() {
    if (busy) return;
    if (file.size > 32 * 1024 * 1024 || duration > 600) {
      setMessage(
        "メモリ節約のため波形生成は32MB・10分以下の素材に限定しています。区間編集と書き出しは利用できます。",
      );
      return;
    }
    setBusy(true);
    const audio = new AudioContext();
    try {
      const decoded = await audio.decodeAudioData(await file.arrayBuffer());
      const channel = decoded.getChannelData(0),
        step = Math.max(1, Math.ceil(decoded.sampleRate / 50)),
        peaks: number[] = [];
      for (let i = 0; i < channel.length; i += step) {
        let lo = 0,
          hi = 0;
        for (let j = i; j < Math.min(i + step, channel.length); j++) {
          lo = Math.min(lo, channel[j]);
          hi = Math.max(hi, channel[j]);
        }
        peaks.push(lo, hi);
      }
      setWaveform({
        schemaVersion: 1,
        versionId: crypto.randomUUID(),
        hash: "a".repeat(64),
        originUs: 0,
        sampleRate: 8000,
        levels: [{ stepUs: (step / decoded.sampleRate) * 1e6, peaks }],
      });
      setMessage("波形生成済み");
    } catch {
      setMessage(
        "この素材の波形を端末で解析できません。プレビューと数値入力は利用できます。",
      );
    } finally {
      await audio.close();
      setBusy(false);
    }
  }
  return (
    <section>
      <button disabled={busy} onClick={() => void wave()}>
        波形を生成
      </button>
      <p>{message}</p>
      <Timeline
        mode={fnf ? "fnf" : "all-versions"}
        durationUs={Math.round(duration * 1e6)}
        currentUs={current}
        items={items}
        markers={markers}
        waveform={waveform}
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
