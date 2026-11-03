"use client";
import { useEffect, useRef, useState } from "react";
import { LocalExport } from "../video-common/LocalExport";
import {
  imageForEncode,
  type LocalEncodeJob,
} from "../../services/video/local-encode";
import { verifyDeveloperAccess } from "../../services/developer/access";
import { fnfFilenames, FNF_HEADING } from "../../domain/video/fnf-showcase";

type Source = {
  id: string;
  file: File;
  url: string;
  duration: number;
  width: number;
  height: number;
  start: number;
  end: number;
  markers: string;
};
type Range = { id: string; start: number; end: number; name: string };
export function localIntervals(
  sources: Pick<Source, "start" | "end" | "duration" | "markers">[],
) {
  let offset = 0;
  return sources.flatMap((s) => {
    if (
      ![s.start, s.end, s.duration].every(Number.isFinite) ||
      s.start < 0 ||
      s.end <= s.start ||
      s.end > s.duration
    )
      throw Error("開始・終了時刻を素材の長さの範囲内で指定してください。");
    const markers = s.markers.trim()
      ? s.markers.split(",").map((v) => Number(v.trim()))
      : [];
    if (
      markers.some(
        (m, i) =>
          !Number.isFinite(m) ||
          m <= s.start ||
          m >= s.end ||
          (i > 0 && m <= markers[i - 1]),
      )
    )
      throw Error(
        "version境界は区間内の秒数を昇順・カンマ区切りで指定してください。",
      );
    const bounds = [s.start, ...markers, s.end];
    const result = bounds.slice(0, -1).map((value, i) => ({
      start: offset + value - s.start,
      end: offset + bounds[i + 1] - s.start,
    }));
    offset += s.end - s.start;
    return result;
  });
}
function metadata(file: File, url: string): Promise<Source> {
  return new Promise((resolve, reject) => {
    const media = document.createElement("video");
    media.preload = "metadata";
    media.playsInline = true;
    const cleanup = () => {
      clearTimeout(timer);
      media.removeAttribute("src");
      media.load();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error("素材の読み込みがタイムアウトしました。"));
    }, 30_000);
    media.onloadedmetadata = () => {
      const { duration, videoWidth: width, videoHeight: height } = media;
      media.onloadedmetadata = null;
      media.onerror = null;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(Error("この素材の長さを読み取れません。"));
        return;
      }
      resolve({
        id: crypto.randomUUID(),
        file,
        url,
        duration,
        width,
        height,
        start: 0,
        end: duration,
        markers: "",
      });
    };
    media.onerror = () => {
      media.onerror = null;
      cleanup();
      reject(Error("この素材の形式は端末で再生できません。"));
    };
    media.src = url;
  });
}
function line(
  ctx: CanvasRenderingContext2D,
  text: string,
  y: number,
  max: number,
  size = 56,
) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  do {
    ctx.font = `700 ${size--}px sans-serif`;
  } while (ctx.measureText(text).width > max && size > 10);
  ctx.lineWidth = 6;
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  ctx.strokeText(text, ctx.canvas.width / 2, y, max);
  ctx.fillText(text, ctx.canvas.width / 2, y, max);
}
export default function LocalVideoTool({
  mode,
  ownerId,
}: {
  mode: "all-versions" | "fnf-showcase";
  ownerId: string;
}) {
  const [sources, setSources] = useState<Source[]>([]),
    [cover, setCover] = useState(""),
    [names, setNames] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]),
    [username, setUsername] = useState("@username");
  const [cropTop, setCropTop] = useState(0),
    [cropBottom, setCropBottom] = useState(0),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const urls = useRef<string[]>([]),
    active = useRef(true);
  const fnf = mode === "fnf-showcase";
  useEffect(() => {
    active.current = true;
    const allocated = urls.current;
    return () => {
      active.current = false;
      allocated.forEach(URL.revokeObjectURL);
    };
  }, []);
  function objectUrl(file: File) {
    const url = URL.createObjectURL(file);
    urls.current.push(url);
    return url;
  }
  async function select(files: File[]) {
    if (!files.length) return;
    setLoading(true);
    setError("");
    try {
      const selected: Source[] = [];
      for (const file of fnf ? files.slice(0, 1) : files) {
        if (!active.current) return;
        selected.push(await metadata(file, objectUrl(file)));
      }
      if (!active.current) return;
      if (fnf && (!selected[0].width || !selected[0].height))
        throw Error("FNFには動画を選択してください。");
      setSources(selected);
      setRanges(
        fnf
          ? [
              {
                id: crypto.randomUUID(),
                start: 0,
                end: Math.min(30, selected[0].duration),
                name: "",
              },
            ]
          : [],
      );
    } catch (e) {
      if (active.current)
        setError(e instanceof Error ? e.message : "素材を読み込めません。");
    } finally {
      if (active.current) setLoading(false);
    }
  }
  async function prepare(): Promise<LocalEncodeJob[]> {
    const access = await verifyDeveloperAccess();
    if (access.ownerId !== ownerId)
      throw Error("アカウントが変更されました。画面を開き直してください。");
    if (!sources.length) throw Error("素材を選択してください。");
    if (fnf) {
      const source = sources[0];
      if (!/^@\S+$/.test(username))
        throw Error("@から始まるユーザー名を入力してください。");
      if (
        ![cropTop, cropBottom].every((v) => Number.isInteger(v) && v >= 0) ||
        cropTop + cropBottom >= source.height
      )
        throw Error("crop後に映像が残る値を指定してください。");
      if (
        !ranges.length ||
        ranges.some(
          (r) =>
            !r.name.trim() ||
            ![r.start, r.end].every(Number.isFinite) ||
            r.start < 0 ||
            r.end <= r.start ||
            r.end > source.duration,
        )
      )
        throw Error("各rangeの譜面名と開始・終了時刻を確認してください。");
      const ordered = [...ranges].sort((a, b) => a.start - b.start),
        filenames = fnfFilenames(ordered.map((r) => r.name));
      const cropped = source.height - cropTop - cropBottom,
        scale = Math.min(1080 / source.width, 1400 / cropped),
        w = source.width * scale,
        h = cropped * scale;
      return ordered.map((range, i) => ({
        filename: filenames[i],
        width: 1080,
        height: 1920,
        pieces: [
          { url: async () => source.url, start: range.start, end: range.end },
        ],
        draw: (ctx, media) => {
          ctx.fillStyle = "black";
          ctx.fillRect(0, 0, 1080, 1920);
          ctx.drawImage(
            media,
            0,
            cropTop,
            source.width,
            cropped,
            (1080 - w) / 2,
            (1920 - h) / 2,
            w,
            h,
          );
          line(ctx, FNF_HEADING, 130, 1000, 46);
          line(ctx, username, 1770, 1000, 64);
        },
      }));
    }
    const intervals = localIntervals(sources),
      labels = names.replace(/\r\n?/g, "\n").split("\n");
    if (labels.length !== intervals.length || labels.some((v) => !v.trim()))
      throw Error(
        `名前をversion数（${intervals.length}）と同じ行数で入力してください。`,
      );
    if (!cover) throw Error("カバー画像を選択してください。");
    const image = await imageForEncode(cover);
    return [
      {
        filename: "All Versions.mp4",
        width: 1920,
        height: 1080,
        pieces: sources.map((s) => ({
          url: async () => s.url,
          start: s.start,
          end: s.end,
        })),
        draw: (ctx, _media, seconds) => {
          ctx.fillStyle = "black";
          ctx.fillRect(0, 0, 1920, 1080);
          ctx.save();
          ctx.globalAlpha = 0.65;
          ctx.filter = "blur(24px)";
          const scale = Math.max(2080 / image.width, 1200 / image.height);
          ctx.drawImage(
            image,
            (1920 - image.width * scale) / 2,
            (1080 - image.height * scale) / 2,
            image.width * scale,
            image.height * scale,
          );
          ctx.restore();
          const crop = Math.min(image.width, image.height);
          ctx.drawImage(
            image,
            (image.width - crop) / 2,
            (image.height - crop) / 2,
            crop,
            crop,
            660,
            130,
            600,
            600,
          );
          const i = intervals.findIndex(
            (v) => seconds >= v.start && seconds < v.end,
          );
          if (i >= 0) {
            ctx.save();
            ctx.globalAlpha = Math.max(
              0,
              Math.min(
                1,
                (seconds - intervals[i].start) / 0.15,
                (intervals[i].end - seconds) / 0.15,
              ),
            );
            line(ctx, labels[i], 920, 1728, 80);
            ctx.restore();
          }
        },
      },
    ];
  }
  function patch(id: string, value: Partial<Source>) {
    setSources((old) => old.map((s) => (s.id === id ? { ...s, ...value } : s)));
  }
  return (
    <main
      className="local-video-tool"
      style={{ maxWidth: 1000, margin: "auto", padding: 16 }}
    >
      <h1>{fnf ? "FNF Showcase Maker" : "All Versions Video Maker"}</h1>
      <p>
        端末の素材を選択して制作します。素材・動画のアップロードは行いません。開発者権限の確認には接続が必要です。
      </p>
      <p>
        編集中の内容はこの画面内に保持されます。移動・再読み込みの前に完成動画を保存してください。
      </p>
      <label>
        端末の素材
        <input
          aria-label="端末の素材"
          type="file"
          accept={fnf ? "video/*" : "audio/*,video/*"}
          multiple={!fnf}
          disabled={loading}
          onChange={(e) => void select(Array.from(e.target.files ?? []))}
        />
      </label>
      {loading && <p role="status">素材を読み込んでいます…</p>}
      {error && <p role="alert">{error}</p>}
      {sources.map((s, i) => (
        <fieldset key={s.id}>
          <legend>
            素材 {i + 1}：{s.file.name}（{s.duration.toFixed(2)}秒）
          </legend>
          <video
            src={s.url}
            controls
            playsInline
            preload="metadata"
            style={{ width: "100%", maxHeight: 360 }}
            aria-label={`素材 ${i + 1} プレビュー`}
          />
          {!fnf && (
            <>
              <label>
                開始秒
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={s.start}
                  onChange={(e) =>
                    patch(s.id, { start: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                終了秒
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={s.end}
                  onChange={(e) => patch(s.id, { end: Number(e.target.value) })}
                />
              </label>
              <label>
                version境界（素材内の秒、カンマ区切り）
                <input
                  value={s.markers}
                  onChange={(e) => patch(s.id, { markers: e.target.value })}
                />
              </label>
              <button
                disabled={i === 0}
                onClick={() =>
                  setSources((old) => {
                    const next = [...old];
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    return next;
                  })
                }
              >
                素材を前へ
              </button>
              <button
                onClick={() =>
                  setSources((old) => old.filter((v) => v.id !== s.id))
                }
              >
                素材を外す
              </button>
            </>
          )}
        </fieldset>
      ))}
      {fnf ? (
        <>
          <label>
            @ユーザー名
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            上crop(px)
            <input
              type="number"
              min={0}
              value={cropTop}
              onChange={(e) => setCropTop(Number(e.target.value))}
            />
          </label>
          <label>
            下crop(px)
            <input
              type="number"
              min={0}
              value={cropBottom}
              onChange={(e) => setCropBottom(Number(e.target.value))}
            />
          </label>
          {ranges.map((r, i) => (
            <fieldset key={r.id}>
              <legend>range {i + 1}</legend>
              {(["start", "end", "name"] as const).map((k) => (
                <label key={k}>
                  {k === "name"
                    ? "譜面名"
                    : k === "start"
                      ? "開始秒"
                      : "終了秒"}
                  <input
                    type={k === "name" ? "text" : "number"}
                    step={k === "name" ? undefined : "0.01"}
                    value={r[k]}
                    onChange={(e) =>
                      setRanges((old) =>
                        old.map((v) =>
                          v.id === r.id
                            ? {
                                ...v,
                                [k]:
                                  k === "name"
                                    ? e.target.value
                                    : Number(e.target.value),
                              }
                            : v,
                        ),
                      )
                    }
                  />
                </label>
              ))}
              <button
                onClick={() =>
                  setRanges((old) => old.filter((v) => v.id !== r.id))
                }
              >
                rangeを削除
              </button>
            </fieldset>
          ))}
          <button
            disabled={!sources.length}
            onClick={() =>
              setRanges((old) => [
                ...old,
                {
                  id: crypto.randomUUID(),
                  start: 0,
                  end: Math.min(30, sources[0].duration),
                  name: "",
                },
              ])
            }
          >
            rangeを追加
          </button>
        </>
      ) : (
        <>
          <label>
            カバー画像
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setCover(objectUrl(f));
              }}
            />
          </label>
          <label>
            version名（1行に1つ）
            <textarea
              rows={6}
              value={names}
              onChange={(e) => setNames(e.target.value)}
            />
          </label>
        </>
      )}
      <LocalExport prepare={prepare} disabled={loading || !sources.length} />
      <style>{`.local-video-tool button,.local-video-tool input,.local-video-tool a{min-height:44px}.local-video-tool label{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.local-video-tool input,.local-video-tool textarea{max-width:100%;font-size:16px}.local-video-tool fieldset{min-width:0;margin:16px 0}.local-video-tool textarea{width:100%}.local-video-tool{overflow-wrap:anywhere}`}</style>
    </main>
  );
}
