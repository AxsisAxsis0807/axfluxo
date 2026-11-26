"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isInteriorBoundary } from "../../services/video/timeline-math";
import LocalCompositionPreview from "./LocalCompositionPreview";
import LocalMediaPreview from "./LocalMediaPreview";
import LocalTimeline from "./LocalTimeline";
import AllVersionsAudioCards from "./AllVersionsAudioCards";
import {
  exportNames,
  reorderAudio,
  updateAudio,
  withAudioOrder,
  type AudioEdit,
} from "./all-versions-edit";
import { LocalExport } from "../video-common/LocalExport";
import { type LocalEncodeJob } from "../../services/video/local-encode";
import { isUnlocked } from "../../services/developer/local-lock";

import {
  buildLocalJobs,
  localProjectIssue,
  type Source,
  type Range,
  type LocalProjectData,
} from "../../services/video/local-project";
import {
  discoverExportRecovery,
  getRecoveryError,
  subscribeRecovery,
} from "../../services/video/local-export-runtime";
export { localIntervals } from "../../services/video/local-project";
// Explicit extensions avoid iOS WebKit treating audio/* like video/* in the Files picker.
const ALL_VERSIONS_MEDIA_ACCEPT =
  ".mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.aif,.aiff,.opus,.mp4,.mov,.m4v,.webm,.mkv";
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
export default function LocalVideoTool({
  mode,
}: {
  mode: "all-versions" | "fnf-showcase";
  ownerId: string;
}) {
  const [layout, setLayout] = useState<NonNullable<LocalProjectData["layout"]>>("reference-pasa-v1");
  const [rest, setRest] = useState(true);
  const recoveryError = useSyncExternalStore(subscribeRecovery, getRecoveryError, () => "");
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  // A single native decoder at a time is critical for mobile Safari.
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [analysisEnabledIds, setAnalysisEnabledIds] = useState<string[]>([]);
  const [projectId] = useState(() => crypto.randomUUID());
  const [coverFile, setCoverFile] = useState<File>();
  const [coverId, setCoverId] = useState("");
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewJobs, setPreviewJobs] = useState<LocalEncodeJob[]>([]);
  const [audio, setAudio] = useState<AudioEdit>({ sources: [], names: "" });
  const { sources, names } = audio;
  const [cover, setCover] = useState("");
  const [songTitle, setSongTitle] = useState("");
  const [openTrimId, setOpenTrimId] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const key = JSON.stringify([songTitle, names, layout, cover, sources.map(
    ({ id, start, end, markers }) => [id, start, end, markers],
  )]);
  const currentPreviewKey = useRef(key);
  currentPreviewKey.current = key;
  function setNames(value: string) {
    setAudio((old) => ({ ...old, names: value }));
  }
  const [ranges, setRanges] = useState<Range[]>([]),
    [username, setUsername] = useState("@username");
  const [scaleFactor, setScaleFactor] = useState(1);
  const [cropTop, setCropTop] = useState(0),
    [cropBottom, setCropBottom] = useState(0),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const urls = useRef<string[]>([]),
    active = useRef(true);
  const fnf = mode === "fnf-showcase";
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      urls.current.forEach(URL.revokeObjectURL);
    };
  }, []);
  useEffect(() => {
    if (!activePreviewId && !previewJobs.length) return;
    const releaseOnBackground = () => {
      if (!document.hidden) return;
      setActivePreviewId(null);
      setPreviewJobs([]);
    };
    const releaseOnPageHide = () => {
      setActivePreviewId(null);
      setPreviewJobs([]);
    };
    document.addEventListener("visibilitychange", releaseOnBackground);
    window.addEventListener("pagehide", releaseOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", releaseOnBackground);
      window.removeEventListener("pagehide", releaseOnPageHide);
    };
  }, [activePreviewId, previewJobs.length]);
  const previousSources = useRef<Source[]>([]);
  useEffect(() => {
    for (const source of previousSources.current) {
      if (!sources.some((current) => current.id === source.id)) {
        URL.revokeObjectURL(source.url);
        urls.current = urls.current.filter((url) => url !== source.url);
      }
    }
    previousSources.current = sources;
  }, [sources]);
  function objectUrl(file: File) {
    const url = URL.createObjectURL(file);
    urls.current.push(url);
    return url;
  }
  function chooseFiles(input: HTMLInputElement) {
    const files = Array.from(input.files ?? []);
    void select(files);
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
      const lightweight = selected
        .filter((source) => source.duration <= 60 && source.file.size <= 64 * 1024 * 1024)
        .map((source) => source.id);
      // Only the first short/small source auto-opens, never multiple decoders.
      // Long videos remain opt-in; All Versions uses audio-only playback.
      setActivePreviewId(lightweight[0] ?? null);
      setPreviewJobs([]);
      setAnalysisEnabledIds((old) => [
        ...(fnf ? [] : old),
        ...lightweight,
      ]);
      setAudio((old) => fnf
        ? { ...old, sources: selected }
        : withAudioOrder(old, [...old.sources, ...selected]));
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
  function template(save: boolean) {
    try {
      const key = `axfluxo.local-video-template.${mode}`;
      if (save)
        localStorage.setItem(
          key,
          JSON.stringify({
            names,
            ...(fnf ? {} : { layout, songTitle }),
            username,
            cropTop,
            cropBottom,
            scaleFactor,
            ranges,
          }),
        );
      else {
        const value = JSON.parse(localStorage.getItem(key) ?? "null");
        if (
          !value ||
          typeof value.names !== "string" ||
          typeof value.username !== "string" ||
          ![value.cropTop, value.cropBottom, value.scaleFactor].every(
            Number.isFinite,
          ) ||
          !Array.isArray(value.ranges) ||
          value.ranges.some(
            (r: Range) =>
              typeof r.name !== "string" ||
              ![r.start, r.end].every(Number.isFinite),
          )
        )
          throw Error();
        setNames(value.names);
        if (!fnf) setSongTitle(typeof value.songTitle === "string" ? value.songTitle : "");
        if (!fnf && (value.layout === "provisional-v1" || value.layout === "reference-pasa-v1"))
          setLayout(value.layout);
        setUsername(value.username);
        setCropTop(value.cropTop);
        setCropBottom(value.cropBottom);
        setScaleFactor(value.scaleFactor);
        setRanges(
          value.ranges.map((r: Range) => ({ ...r, id: crypto.randomUUID() })),
        );
      }
      setError(
        save
          ? "テンプレートをこの端末に保存しました。素材は含まれません。"
          : "テンプレートを読み込みました。素材と区間を確認してください。",
      );
    } catch {
      setError(
        "テンプレートを保存・読み込みできません。保存領域と保存済み設定を確認してください。",
      );
    }
  }
  async function prepare(): Promise<LocalEncodeJob[]> {
    if (!isUnlocked(sessionStorage))
      throw Error("簡易ロックを解除してください。");
    const snapshot = projectData();
    return buildLocalJobs({
      ...snapshot,
      sources: snapshot.sources.map(({ timeline, ...source }) => {
        void timeline;
        return source;
      }),
    });
  }
  useEffect(() => {
    const control = new AbortController();
    void discoverExportRecovery(control.signal);
    return () => control.abort();
  }, [recoveryAttempt]);
  function projectData(): LocalProjectData {
    return {
      rest,
      ...(fnf ? {} : { layout }),
      id: projectId,
      mode,
      sources,
      cover,
      coverFile,
      coverId,
      names: fnf ? names : exportNames(songTitle, names),
      ranges,
      username,
      scaleFactor,
      cropTop,
      cropBottom,
    };
  }
  function patch(id: string, value: Partial<Source>) {
    setAudio((old) => fnf
      ? { ...old, sources: old.sources.map((s) => s.id === id ? { ...s, ...value } : s) }
      : updateAudio(old, id, value));
  }
  function toggleTrim(id: string) {
    const closing = openTrimId === id;
    if (closing || activePreviewId !== id) setActivePreviewId(null);
    setOpenTrimId(closing ? null : id);
  }
  function renderTrim(s: Source, i: number) {
    return (
      <>
          {activePreviewId === s.id ? (
            <>
              <button onClick={() => setActivePreviewId(null)}>
                素材 {i + 1} のプレビューを閉じる
              </button>
              <LocalMediaPreview
                id={s.id}
                url={s.url}
                audioOnly={!fnf}
                warmMetadata={s.duration <= 60 && s.file.size <= 64 * 1024 * 1024}
                onError={() => {
                  setActivePreviewId(null);
                  setError("この端末では素材プレビューを再生できません。元の素材と編集内容は保持されています。");
                }}
              />
            </>
          ) : (
            <button
              onClick={() => {
                setPreviewJobs([]);
                setActivePreviewId(s.id);
              }}
            >
              素材 {i + 1} のプレビューを読み込む
            </button>
          )}
          {!analysisEnabledIds.includes(s.id) && (
            <button
              onClick={() => setAnalysisEnabledIds((ids) => [...ids, s.id])}
            >
              素材 {i + 1} の波形を解析する
            </button>
          )}
          <LocalTimeline
            key={s.id}
            analysisEnabled={analysisEnabledIds.includes(s.id)}
            file={s.file}
            timeline={s.timeline}
            onTimelineState={(state) => {
              if (JSON.stringify(s.timeline) !== JSON.stringify(state))
                patch(s.id, { timeline: state });
            }}
            duration={s.duration}
            media={() =>
              document.getElementById(
                `local-media-${s.id}`,
              ) as HTMLMediaElement | null
            }
            fnf={fnf}
            items={
              fnf
                ? ranges.map((r) => ({
                    id: r.id,
                    startUs: Math.round(r.start * 1e6),
                    endUs: Math.round(r.end * 1e6),
                    label: r.name || "range",
                  }))
                : [
                    {
                      id: s.id,
                      startUs: Math.round(s.start * 1e6),
                      endUs: Math.round(s.end * 1e6),
                      label: s.file.name,
                    },
                  ]
            }
            onMarkerAdd={
              fnf
                ? undefined
                : (us) => {
                    const markers = s.markers
                      .split(",")
                      .filter((v) => v.trim())
                      .map(Number);
                    if (
                      markers.some((m) => !Number.isFinite(m)) ||
                      !isInteriorBoundary(us, s.start * 1e6, s.end * 1e6)
                    )
                      return;
                    patch(s.id, {
                      markers: [...new Set([...markers, us / 1e6])]
                        .sort((a, b) => a - b)
                        .join(","),
                    });
                  }
            }
            onMarkerDelete={
              fnf
                ? undefined
                : (index) =>
                    patch(s.id, {
                      markers: s.markers
                        .split(",")
                        .filter((v) => v.trim())
                        .filter((_, i) => i !== index)
                        .join(","),
                    })
            }
            onMarkerEdit={
              fnf
                ? undefined
                : (index, us) => {
                    const markers = s.markers.split(",").map(Number);
                    markers[index] = us / 1e6;
                    patch(s.id, { markers: markers.join(",") });
                  }
            }
            markers={s.markers
              .split(",")
              .filter((v) => v.trim() && Number.isFinite(Number(v)))
              .map((v) => Number(v) * 1e6)}
            onEdit={(id, start, end) =>
              fnf
                ? setRanges((old) =>
                    old.map((r) => (r.id === id ? { ...r, start, end } : r)),
                  )
                : patch(id, {
                    start,
                    end,
                    markers: s.markers
                      .split(",")
                      .filter(
                        (v) => v.trim() && Number(v) > start && Number(v) < end,
                      )
                      .join(","),
                  })
            }
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
                onClick={() => {
                  setActivePreviewId(null);
                  setOpenTrimId(null);
                  setAnalysisEnabledIds((ids) => ids.filter((id) => id !== s.id));
                  setAudio((old) => withAudioOrder(old, old.sources.filter((item) => item.id !== s.id)));
                }}
              >
                素材を外す
              </button>
            </>
          )}
      </>
    );
  }
  return (
    <main
      className="local-video-tool"
      style={{ maxWidth: 1000, margin: "auto", padding: 16 }}
    >
      <h1>{fnf ? "FNF Showcase Maker" : "All Versions Video Maker"}</h1>
      {!fnf && (
        <label>
          レイアウト
          <select value={layout} onChange={(event) => {
            setLayout(event.target.value === "provisional-v1" ? "provisional-v1" : "reference-pasa-v1");
            setPreviewJobs([]);
          }}>
            <option value="reference-pasa-v1">参考動画再現（中央文字＋経過時間）</option>
            <option value="provisional-v1">従来レイアウト</option>
          </select>
        </label>
      )}
      <p>
        端末の素材を選択して制作します。素材・動画のアップロードは行いません。端末内機能はログイン・動画APIなしで利用できます。
      </p>
      {recoveryError && (
        <section aria-label="書き出しデータの復旧">
          <p role="alert">{recoveryError}</p>
          <button onClick={() => setRecoveryAttempt((attempt) => attempt + 1)}>
            書き出しデータの復旧を再試行
          </button>
        </section>
      )}
      <button onClick={() => template(true)}>テンプレートを端末に保存</button>
      <button onClick={() => template(false)}>
        端末のテンプレートを読み込む
      </button>
      <label>
        端末の素材
        <input
          aria-label="端末の素材"
          type="file"
          accept={fnf ? "video/*" : ALL_VERSIONS_MEDIA_ACCEPT}
          multiple={!fnf}
          disabled={loading}
          onChange={(e) => chooseFiles(e.currentTarget)}
        />
      </label>
      {!fnf && (
        <label>
          MP3などが表示されない場合（ファイル形式の制限なし）
          <input
            aria-label="形式の制限なしで素材を選択"
            type="file"
            multiple
            disabled={loading}
            onChange={(e) => chooseFiles(e.currentTarget)}
          />
        </label>
      )}
      {loading && <p role="status">素材を読み込んでいます…</p>}
      {error && <p role="alert">{error}</p>}
      {!fnf && (
        <p>All Versionsの素材プレビューは音声のみ再生します。元動画の高解像度映像を読み込まず、iPhoneの負荷を抑えます。</p>
      )}
      {fnf ? sources.map((s, i) => (
        <fieldset key={s.id}>
          <legend>
            素材 {i + 1}：{s.file.name}（{s.duration.toFixed(2)}秒）
          </legend>
          {renderTrim(s, i)}
        </fieldset>
      )) : (
        <AllVersionsAudioCards
          edit={audio}
          songTitle={songTitle}
          onTitle={setSongTitle}
          onNames={setNames}
          openId={openTrimId}
          onToggle={toggleTrim}
          onMove={(id, direction) => setAudio((old) => reorderAudio(old, id, direction))}
          renderTrim={(index) => renderTrim(sources[index], index)}
        />
      )}
      {fnf ? (
        <>
          <label>
            映像スケール
            <input
              type="number"
              min="0.1"
              max="2"
              step="0.1"
              value={scaleFactor}
              onChange={(e) => setScaleFactor(Number(e.target.value))}
            />
          </label>
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
                    onChange={(e) => {
                      // Snapshot the DOM value during the event. React may
                      // evaluate/replay the updater after the controlled input
                      // has been restored or another edit has changed its value.
                      const value = e.currentTarget.value;
                      const nextValue = k === "name" ? value : Number(value);
                      setRanges((old) =>
                        old.map((v) =>
                          v.id === r.id ? { ...v, [k]: nextValue } : v,
                        ),
                      );
                    }}
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
                if (f) {
                  setCover(objectUrl(f));
                  setCoverFile(f);
                  setCoverId(crypto.randomUUID());
                }
              }}
            />
          </label>
        </>
      )}
      <button
        disabled={loading || !sources.length}
        onClick={() => {
          setActivePreviewId(null);
          void prepare()
            .then((jobs) => {
              if (!fnf && currentPreviewKey.current !== key) return;
              setPreviewKey(key);
              setPreviewJobs(jobs);
            })
            .catch((e) =>
              setError(
                e instanceof Error ? e.message : "プレビューを準備できません。",
              ),
            );
        }}
      >
        合成プレビューを更新
      </button>
      {previewJobs.length > 0 && (fnf || previewKey === key) && (
        <>
          <label>
            プレビューする出力
            <select
              value={Math.min(previewIndex, previewJobs.length - 1)}
              onChange={(e) => setPreviewIndex(Number(e.target.value))}
            >
              {previewJobs.map((job, i) => (
                <option key={i} value={i}>
                  {job.filename}
                </option>
              ))}
            </select>
          </label>
          <LocalCompositionPreview
            key={Math.min(previewIndex, previewJobs.length - 1)}
            job={previewJobs[Math.min(previewIndex, previewJobs.length - 1)]}
            audioOnly={!fnf}
          />
        </>
      )}
      <p role="status">{localProjectIssue(projectData())}</p>
      <LocalExport
        prepare={prepare}
        disabled={loading}
        rest={rest}
        onRestChange={setRest}
      />
      <style>{`.local-video-tool button,.local-video-tool input,.local-video-tool a{min-height:44px}.local-video-tool label{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.local-video-tool input,.local-video-tool textarea{max-width:100%;font-size:16px}.local-video-tool fieldset{min-width:0;margin:16px 0}.local-video-tool textarea{width:100%}.local-video-tool{overflow-wrap:anywhere}`}</style>
    </main>
  );
}
