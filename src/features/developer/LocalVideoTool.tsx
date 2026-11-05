"use client";
import { useEffect, useRef, useState } from "react";
import LocalCompositionPreview from "./LocalCompositionPreview";
import LocalTimeline from "./LocalTimeline";
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
  loadLocalProject,
  saveLocalProject,
  renewRecoveryLease,
  releaseProjectUrls,
  recoveryMessage,
  RecoveryLeaseError,
} from "../../services/video/recovery-store";
import {
  initializeExportRecovery,
  localExportQueue,
} from "../../services/video/local-export-runtime";
export { localIntervals } from "../../services/video/local-project";
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
  const [rest, setRest] = useState(true);
  const [ready, setReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState("保存データを確認中…");
  const saveTail = useRef(Promise.resolve());
  const [projectId, setProjectId] = useState("");
  const [coverFile, setCoverFile] = useState<File>();
  const [coverId, setCoverId] = useState("");
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewJobs, setPreviewJobs] = useState<LocalEncodeJob[]>([]);
  const [sources, setSources] = useState<Source[]>([]),
    [cover, setCover] = useState(""),
    [names, setNames] = useState("");
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
      setSources((old) => (fnf ? selected : [...old, ...selected]));
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
  async function prepare(durable = true): Promise<LocalEncodeJob[]> {
    if (!isUnlocked(sessionStorage))
      throw Error("簡易ロックを解除してください。");
    if (!ready) throw Error("自動復旧用の保存領域を確認してください。");
    if (durable) await saveTail.current;
    return buildLocalJobs(projectData());
  }
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      try {
        let saved: LocalProjectData | undefined;
        for (let attempt = 0; ; attempt++) {
          if (disposed) return;
          try {
            saved = await loadLocalProject(mode);
            break;
          } catch (error) {
            if (!(error instanceof RecoveryLeaseError) || attempt >= 25)
              throw error;
            setSaveStatus(
              "前のタブの処理終了を確認中… 自動復旧まで最大約20秒お待ちください。",
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        if (disposed) {
          if (saved) releaseProjectUrls(saved);
          return;
        }
        if (saved) {
          urls.current.push(
            ...saved.sources.map((s) => s.url),
            ...(saved.cover ? [saved.cover] : []),
          );
          setProjectId(saved.id);
          setSources(saved.sources);
          setCover(saved.cover);
          setCoverFile(saved.coverFile);
          setCoverId(saved.coverId);
          setNames(saved.names);
          setRest(saved.rest ?? true);
          setRanges(saved.ranges);
          setUsername(saved.username);
          setScaleFactor(saved.scaleFactor);
          setCropTop(saved.cropTop);
          setCropBottom(saved.cropBottom);
        } else setProjectId(crypto.randomUUID());
        await initializeExportRecovery();
        if (disposed) return;
        setReady(true);
        setSaveStatus(
          saved
            ? "編集内容と書き出しを自動復元しました。"
            : "変更はこの端末に自動保存します。",
        );
        timer = setInterval(() => {
          void renewRecoveryLease().catch((e) => {
            localExportQueue.pause(true);
            setReady(false);
            setSaveStatus(recoveryMessage(e));
          });
        }, 5000);
      } catch (e) {
        if (!disposed) setSaveStatus(recoveryMessage(e));
      }
    })();
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [mode]);
  useEffect(() => {
    if (!ready || !projectId) return;
    const snapshot: LocalProjectData = {
      rest,
      id: projectId,
      mode,
      sources,
      cover,
      coverFile,
      coverId,
      names,
      ranges,
      username,
      scaleFactor,
      cropTop,
      cropBottom,
    };
    setSaveStatus("自動保存中…");
    // Ordered writes survive unmount. No unload handler is relied on for durability.
    let latest = true;
    saveTail.current = saveLocalProject(snapshot);
    void saveTail.current
      .then(() => {
        if (latest)
          setSaveStatus(
            "この端末に自動保存済み。Safariによる保存領域の削除に備え、元の素材も保持してください。",
          );
      })
      .catch((e) => {
        if (latest) setSaveStatus(recoveryMessage(e));
      });
    return () => {
      latest = false;
    };
  }, [
    ready,
    rest,
    projectId,
    mode,
    sources,
    cover,
    coverFile,
    coverId,
    names,
    ranges,
    username,
    scaleFactor,
    cropTop,
    cropBottom,
  ]);
  function projectData(): LocalProjectData {
    return {
      rest,
      id: projectId,
      mode,
      sources,
      cover,
      coverFile,
      coverId,
      names,
      ranges,
      username,
      scaleFactor,
      cropTop,
      cropBottom,
    };
  }
  function patch(id: string, value: Partial<Source>) {
    setSources((old) => old.map((s) => (s.id === id ? { ...s, ...value } : s)));
  }
  if (!ready)
    return (
      <main style={{ maxWidth: 1000, margin: "auto", padding: 16 }}>
        <h1>{fnf ? "FNF Showcase Maker" : "All Versions Video Maker"}</h1>
        <p role="status">{saveStatus}</p>
      </main>
    );
  return (
    <main
      className="local-video-tool"
      style={{ maxWidth: 1000, margin: "auto", padding: 16 }}
    >
      <h1>{fnf ? "FNF Showcase Maker" : "All Versions Video Maker"}</h1>
      <p>
        端末の素材を選択して制作します。素材・動画のアップロードは行いません。端末内機能はログイン・動画APIなしで利用できます。
      </p>
      <p
        role="status"
        data-testid="local-save-status"
        style={{ minHeight: "5.7em" }}
      >
        {saveStatus}
      </p>
      <button onClick={() => template(true)}>テンプレートを端末に保存</button>
      <button onClick={() => template(false)}>
        端末のテンプレートを読み込む
      </button>
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
            id={`local-media-${s.id}`}
            src={s.url}
            controls
            playsInline
            preload="metadata"
            style={{ width: "100%", maxHeight: 360 }}
            aria-label={`素材 ${i + 1} プレビュー`}
          />
          <LocalTimeline
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
              ) as HTMLVideoElement | null
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
                if (f) {
                  setCover(objectUrl(f));
                  setCoverFile(f);
                  setCoverId(crypto.randomUUID());
                }
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
      <button
        disabled={loading || !sources.length}
        onClick={() =>
          void prepare(false)
            .then(setPreviewJobs)
            .catch((e) =>
              setError(
                e instanceof Error ? e.message : "プレビューを準備できません。",
              ),
            )
        }
      >
        合成プレビューを更新
      </button>
      {previewJobs.length > 0 && (
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
          />
        </>
      )}
      <p role="status">{localProjectIssue(projectData())}</p>
      <LocalExport
        prepare={prepare}
        disabled={loading || !ready}
        rest={rest}
        onRestChange={setRest}
      />
      <style>{`.local-video-tool button,.local-video-tool input,.local-video-tool a{min-height:44px}.local-video-tool label{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.local-video-tool input,.local-video-tool textarea{max-width:100%;font-size:16px}.local-video-tool fieldset{min-width:0;margin:16px 0}.local-video-tool textarea{width:100%}.local-video-tool{overflow-wrap:anywhere}`}</style>
    </main>
  );
}
