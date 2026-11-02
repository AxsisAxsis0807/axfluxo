"use client";
/* eslint-disable @next/next/no-img-element -- Private signed media and server-rasterized PNGs use native images without an optimization service. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { allVersionsDocumentSchema } from "../../domain/video/schema";
import {
  newProject,
  projectNames,
  projectIssues,
  versionIntervals,
  textAlpha,
  type AllVersionsProject,
} from "../../domain/video/all-versions";
import {
  VideoPreview,
  type PreviewResolver,
} from "../video-common/VideoPreview";
import { toFrame } from "../../domain/video/time";
import { TimeField } from "../video-common/TimeField";
import CloudLibrary from "../developer/CloudLibrary";
import type { CloudAsset } from "../../domain/cloud-library/media";
import {
  cloudClient,
  type AuthenticatedApi,
} from "../../services/cloud-library/client";
import {
  createVideoApiClient,
  currentVideoSessionSource,
} from "../../services/video/api-client";
import { projectsClient } from "../../services/video/projects-client";
import {
  ProjectSaveQueue,
  syncProject,
} from "../../services/video/project-sync";
import {
  localProject,
  forkConflict,
  syncEntry,
  listProjects,
} from "../../services/developer-storage/projects";
import { PlaybackError } from "../../services/video/playback";
const steps = [
  "素材",
  "音声編集",
  "名前",
  "デザイン",
  "全長preview",
  "書き出し",
];
const messages: Record<string, string> = {
  NAME_COUNT: "名前とversionの数が一致しません。",
  EMPTY_NAME: "空行があります。原文は保持されています。",
  FADE_TOO_LONG: "fade合計が短い区間に収まりません。",
  VERSION_ZERO_FRAMES: "同じframeの境界があります。markerを確認してください。",
  COVER_REQUIRED: "正方形表示のcoverを選択してください。",
  MEDIA_REQUIRED: "音声素材を選択してください。",
  PROJECT_CONFLICT: "409：競合しました。ローカルとcloudを両方保持しています。",
  FONT_GLYPH_UNSUPPORTED:
    "Aleoで描画できない文字があります。代替fontに変更していません。",
  FONT_UNAVAILABLE: "固定fontを使用できません。",
  AUTH_EXPIRED: "認証の期限が切れました。端末内のprojectは保持されています。",
  AUTH_REQUIRED: "ログインしてください。",
  REQUEST_FAILED:
    "接続できません。端末に保存し、cloud同期を後で再試行できます。",
  LOCAL_QUOTA: "端末への保存に失敗しました。編集内容は画面に保持されています。",
};
export function AllVersionsEditor({
  api: injected,
}: {
  api?: AuthenticatedApi;
}) {
  const enabled =
    !!injected || process.env.NEXT_PUBLIC_ALL_VERSIONS_ENABLED === "true";
  const api = useMemo(() => {
    if (injected) return injected;
    if (!enabled) return null;
    const session = currentVideoSessionSource(),
      baseUrl = process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
    if (!session || !baseUrl) return null;
    try {
      return createVideoApiClient({ baseUrl, session });
    } catch {
      return null;
    }
  }, [enabled, injected]);
  const cloud = useMemo(() => (api ? cloudClient(api) : null), [api]);
  const [project, setProject] = useState<AllVersionsProject>(() =>
      newProject(),
    ),
    [owner, setOwner] = useState<string | null>(null),
    [step, setStep] = useState(0),
    [localState, setLocalState] = useState("未保存"),
    [cloudState, setCloudState] = useState("未同期"),
    [error, setError] = useState(""),
    [openId, setOpenId] = useState(""),
    [localList, setLocalList] = useState<{ id: string; revision: number }[]>(
      [],
    ),
    [clock, setClock] = useState(0),
    [coverUrl, setCoverUrl] = useState(""),
    [text, setText] = useState(""),
    [batch, setBatch] = useState(""),
    [status, setStatus] = useState(""),
    [output, setOutput] = useState("");
  const remote = useMemo(
    () => (api && owner ? projectsClient(api, owner) : null),
    [api, owner],
  );
  const queue = useRef<ProjectSaveQueue | null>(null),
    docRef = useRef(project),
    generation = useRef(0),
    rendered = useRef<{ key: string; batch: string } | null>(null),
    finalVideo = useRef<HTMLVideoElement | null>(null),
    finalPosition = useRef(0);
  docRef.current = project;
  useEffect(() => {
    if (!api) return;
    let live = true;
    void api.me().then(async (r) => {
      if (live) {
        if (r.ok) setOwner(r.data.ownerId);
        else {
          setError(r.code);
          if (!navigator.onLine || r.code === "REQUEST_FAILED") {
            try {
              const session = await currentVideoSessionSource()?.getSession();
              const id = session?.data.session?.user?.id;
              if (live && id) {
                setOwner(id);
                setCloudState("offline編集・cloud権限は未確認");
              }
            } catch {
              /* Local editor remains closed if the session owner is unavailable. */
            }
          }
        }
      }
    });
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => {
    if (owner)
      void listProjects(owner)
        .then(setLocalList)
        .catch(() => setError("LOCAL_QUOTA"));
  }, [owner, localState]);
  useEffect(() => {
    if (!owner) return;
    const q = new ProjectSaveQueue(owner);
    q.onState = (s) =>
      setLocalState(
        s === "local-saved"
          ? "端末に保存済み"
          : s === "local-error"
            ? "端末：未保存"
            : "端末：保存待ち",
      );
    queue.current = q;
    return () => {
      const current = queue.current;
      void current?.flush().catch(() => {});
      current?.dispose();
      q.dispose();
      queue.current = null;
    };
  }, [owner]);
  useEffect(() => {
    if (!owner || !remote) return;
    let stopped = false;
    const sync = () => {
      if (stopped || !navigator.onLine) return;
      const id = docRef.current.id;
      void (async () => {
        if (!(await syncEntry(owner, id))) return false;
        await syncProject(owner, id, remote.transport);
        return true;
      })()
        .then(async (synced) => {
          const pending = await syncEntry(owner, id);
          if (!stopped && synced && docRef.current.id === id)
            setCloudState(
              !pending && queue.current?.isSaved
                ? "cloudに保存済み"
                : "cloud：未同期",
            );
        })
        .catch((e) => {
          if (!stopped) {
            setCloudState("cloud：未同期／競合");
            if (e.message === "PROJECT_CONFLICT") setError(e.message);
          }
        });
    };
    const timer = setInterval(sync, 1500);
    window.addEventListener("online", sync);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("online", sync);
    };
  }, [owner, remote]);
  const change = useCallback((next: AllVersionsProject) => {
    generation.current++;
    setProject(next);
    docRef.current = next;
    queue.current?.schedule(next);
    setCloudState("cloud：未同期");
    setError("");
    rendered.current = null;
    setBatch("");
    setOutput("");
  }, []);
  const resolve: PreviewResolver = useCallback(
    async (ref) => {
      if (!cloud) throw new PlaybackError("AUTH_EXPIRED");
      const r = await cloud.preview(ref.versionId);
      if (!r.ok)
        throw new PlaybackError(
          r.code === "PROXY_NOT_READY"
            ? "PROXY_NOT_READY"
            : r.state === "auth-expired"
              ? "AUTH_EXPIRED"
              : "PREVIEW_FAILED",
        );
      return r.data;
    },
    [cloud],
  );
  async function selected(asset: CloudAsset) {
    try {
      if (!cloud) return;
      const ref = {
        libraryId: "cloud",
        fileId: asset.id,
        versionId: asset.versionId,
        hash: asset.hash,
        kind: asset.kind,
      };
      if (asset.kind === "image") {
        change({ ...docRef.current, cover: ref });
        return;
      }
      const info = await resolve(ref),
        old = docRef.current;
      const clip = {
        id: crypto.randomUUID(),
        source: ref,
        sourceDurationUs: info.durationUs,
        interval: { startUs: 0, endUs: info.durationUs },
        markersUs: [],
      };
      const document = allVersionsDocumentSchema.parse(
        old.document
          ? { ...old.document, clips: [...old.document.clips, clip] }
          : {
              schemaVersion: 1,
              kind: "all-versions",
              id: crypto.randomUUID(),
              revision: 0,
              fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
              clips: [clip],
            },
      );
      change({ ...old, document });
    } catch (e) {
      setError(e instanceof Error ? e.message : "PREVIEW_FAILED");
    }
  }
  const versions = versionIntervals(project),
    names = projectNames(project),
    issues = projectIssues(project),
    frame = toFrame(clock),
    index = Math.max(
      0,
      versions.findIndex((v) => frame >= v.startFrame && frame < v.endFrame),
    );
  const textKey = JSON.stringify({
    name: names[index],
    design: project.design,
  });
  useEffect(() => {
    let live = true;
    setText("");
    if (remote && projectNames(docRef.current)[index]?.trim())
      void remote
        .text(docRef.current, index)
        .then((r) => {
          if (live) setText(`data:image/png;base64,${r.png}`);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [remote, textKey, index]);
  useEffect(() => {
    let live = true;
    setCoverUrl("");
    if (project.cover && cloud)
      void cloud.access(project.cover.versionId).then((r) => {
        if (live && r.ok) setCoverUrl(r.data.url);
      });
    return () => {
      live = false;
    };
  }, [cloud, project.cover]);
  async function save(sync = true) {
    try {
      const id = docRef.current.id;
      queue.current?.schedule(docRef.current);
      await queue.current?.flush();
      if (sync && owner && remote) {
        setCloudState("cloud：同期中");
        await syncProject(owner, id, remote.transport);
        const pending = await syncEntry(owner, id);
        if (docRef.current.id === id)
          setCloudState(
            !pending && queue.current?.isSaved
              ? "cloudに保存済み"
              : "cloud：未同期",
          );
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "LOCAL_QUOTA");
      setCloudState("cloud：未同期／競合");
      return false;
    }
  }
  async function open() {
    try {
      if (!owner || !remote) return;
      const request = ++generation.current;
      await queue.current?.flush();
      let row = await localProject(owner, openId);
      if (!row) {
        const r = await remote.get(openId);
        if (!r.ok) throw new Error(r.code);
        const { saveProject, acknowledge } =
          await import("../../services/developer-storage/projects");
        row = await saveProject(owner, r.data.project, 0);
        await acknowledge(owner, openId, row.revision, r.data.revision);
      }
      if (request !== generation.current) return;
      queue.current?.dispose();
      const q = new ProjectSaveQueue(owner, row.revision);
      q.onState = (s) =>
        setLocalState(s === "local-saved" ? "端末に保存済み" : "端末：未保存");
      queue.current = q;
      setProject(row.project);
      setError(row.conflict ? "PROJECT_CONFLICT" : "");
      setCloudState(row.conflict ? "cloud：競合" : "cloud：保存状態を再確認");
    } catch (e) {
      setError(e instanceof Error ? e.message : "PROJECT_NOT_FOUND");
    }
  }
  async function exportVideo() {
    if (rendered.current?.key === JSON.stringify(project)) {
      setBatch(rendered.current.batch);
      return;
    }
    if (issues.length) {
      setError(issues[0]);
      return;
    }
    const request = generation.current;
    if (!(await save()) || request !== generation.current) return;
    try {
      if (!owner || !remote) return;
      const row = await localProject(owner, project.id);
      if (!row || row.conflict) throw new Error("PROJECT_CONFLICT");
      const r = await remote.render(project.id, row.cloudRevision);
      if (request !== generation.current) return;
      rendered.current = { key: JSON.stringify(project), batch: r.id };
      setBatch(r.id);
      setStatus("待機中");
    } catch (e) {
      setError(e instanceof Error ? e.message : "PROJECT_INVALID");
    }
  }
  async function check() {
    if (!api || !batch) return;
    const r = await api.getBatch(batch);
    if (!r.ok) {
      setError(r.code);
      return;
    }
    setStatus(r.state);
    if (r.state === "failed" || r.state === "cancelled")
      rendered.current = null;
    const o = r.data.outputs[0];
    if (o) {
      const { z } = await import("zod");
      const s = await api.request(
        `/render-outputs/${o.id}/access`,
        z.object({
          url: z.string(),
          expiresAt: z.number(),
          hash: z.string(),
          size: z.number(),
        }),
      );
      if (s.ok) setOutput(s.data.url);
    }
  }
  if (!enabled)
    return (
      <main>
        <h1>All Versions</h1>
        <p>入口はOFFです。projectと原本は保持されています。</p>
      </main>
    );
  if (!api)
    return (
      <main>
        <h1>All Versions</h1>
        <p>開発者APIとログインを設定してください。</p>
      </main>
    );
  return (
    <main style={{ maxWidth: 1100, margin: "auto", padding: 16 }}>
      <h1>All Versions Video Maker</h1>
      <p>暫定layoutです。参考画像との一致は未検証です。</p>
      <p>
        project ID：<output>{project.id}</output>
      </p>
      <p role="status" aria-label="保存状態">
        {localState} ／ {cloudState}
      </p>
      {error && <p role="alert">{messages[error] ?? error}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button onClick={() => void save()}>手動保存・同期</button>
        <button onClick={() => void save(false)}>端末保存を確定</button>
        <label>
          開くproject ID
          <input value={openId} onChange={(e) => setOpenId(e.target.value)} />
        </label>
        <button onClick={() => void open()}>projectを開く</button>
        <button
          onClick={() => {
            if (owner)
              void forkConflict(owner, project.id, docRef.current).then(
                (row) => {
                  setOpenId(row.project.id);
                  setError(
                    "競合元を保持して別projectを作成しました。新しいIDを開いてください。",
                  );
                },
              );
          }}
        >
          競合を別projectとして保持
        </button>
      </div>
      {localList.length > 0 && (
        <label>
          端末のproject一覧
          <select value={openId} onChange={(e) => setOpenId(e.target.value)}>
            <option value="">選択してください</option>
            {localList.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}（revision {r.revision}）
              </option>
            ))}
          </select>
        </label>
      )}
      <nav
        aria-label="制作手順"
        style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
      >
        {steps.map((s, i) => (
          <button
            key={s}
            aria-current={step === i ? "step" : undefined}
            style={{ minHeight: 44 }}
            onClick={() => setStep(i)}
          >
            {i + 1}. {s}
          </button>
        ))}
      </nav>
      {step === 0 && cloud && (
        <>
          <p>
            MP3 / WAV / M4A / MP4 /
            MOV。動画は音声を抽出して使います。proxy準備後に「使用」を選択してください。画像はcoverになります。
          </p>
          <CloudLibrary client={cloud} onSelect={(a) => void selected(a)} />
        </>
      )}
      {(step === 1 || step === 4) && project.document && (
        <VideoPreview
          mode="all-versions"
          document={project.document}
          onDocumentChange={(document) =>
            change({ ...docRef.current, document })
          }
          resolve={resolve}
          onTimeChange={setClock}
          overlay={
            step === 4 ? (
              <div
                style={{ position: "absolute", inset: 0, background: "black" }}
              >
                {coverUrl && (
                  <>
                    <div
                      style={{
                        position: "absolute",
                        inset: "-6%",
                        backgroundImage: `url(${JSON.stringify(coverUrl)})`,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                        filter: "blur(24px)",
                        opacity: 0.7,
                      }}
                    />
                    <img
                      width={1920}
                      height={1080}
                      alt="cover"
                      src={coverUrl}
                      style={{
                        position: "absolute",
                        height: "56%",
                        width: "31.5%",
                        aspectRatio: "1",
                        objectFit: "cover",
                        left: "50%",
                        top: "12%",
                        transform: "translateX(-50%)",
                      }}
                    />
                  </>
                )}
                <div
                  style={{
                    position: "absolute",
                    left: "5%",
                    right: "5%",
                    top: "78%",
                    height: "15%",
                    background: "rgba(0,0,0,.48)",
                  }}
                />
                {text && (
                  <img
                    width={1920}
                    height={1080}
                    alt="server生成の文字"
                    src={text}
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      opacity: versions[index]
                        ? textAlpha(frame, versions[index], project.design)
                        : 0,
                    }}
                  />
                )}
              </div>
            ) : undefined
          }
        />
      )}
      {step === 1 &&
        project.document?.clips.map((c, i) => (
          <fieldset key={c.id}>
            <legend>clip {i + 1}・結合順</legend>
            <button
              disabled={i === 0}
              onClick={() => {
                const clips = [...project.document!.clips];
                [clips[i - 1], clips[i]] = [clips[i], clips[i - 1]];
                change({
                  ...project,
                  document: { ...project.document!, clips },
                });
              }}
            >
              前へ移動
            </button>
            <p>
              境界は連結順から自動計算します。markerは元時刻のまま保持します。
            </p>
            {c.markersUs.map((m, j) => (
              <div key={`${j}`}>
                <TimeField
                  label={`clip ${i + 1} marker ${j + 1}`}
                  value={m}
                  onCommit={(us) => {
                    try {
                      const markers = c.markersUs
                        .map((v, n) => (n === j ? us : v))
                        .sort((a, b) => a - b);
                      change({
                        ...project,
                        document: allVersionsDocumentSchema.parse({
                          ...project.document,
                          clips: project.document!.clips.map((v, n) =>
                            n === i ? { ...v, markersUs: markers } : v,
                          ),
                        }),
                      });
                    } catch {
                      setError(
                        "markerが重複するか区間外です。変更前の値を保持しました。",
                      );
                    }
                  }}
                  onError={() => setError("無効な時刻です。")}
                />
                <button
                  onClick={() =>
                    change({
                      ...project,
                      document: {
                        ...project.document!,
                        clips: project.document!.clips.map((v, n) =>
                          n === i
                            ? {
                                ...v,
                                markersUs: v.markersUs.filter(
                                  (_, k) => k !== j,
                                ),
                              }
                            : v,
                        ),
                      },
                    })
                  }
                >
                  markerを削除
                </button>
              </div>
            ))}
          </fieldset>
        ))}
      {step === 2 && (
        <>
          <label>
            version名（1行につき1つ）
            <textarea
              rows={10}
              value={project.namesText}
              onChange={(e) =>
                change({ ...project, namesText: e.target.value })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={project.removeNumbers}
              onChange={(e) =>
                change({ ...project, removeNumbers: e.target.checked })
              }
            />
            先頭番号を除去（任意・原文は保持）
          </label>
          <p>
            {versions.length} versions ／ {names.length} 名前
          </p>
          <ol>
            {names.map((n, i) => (
              <li key={i}>{n || "（空行）"}</li>
            ))}
          </ol>
        </>
      )}
      {step === 3 && (
        <>
          <label>
            出力解像度
            <select
              value={project.design.height}
              onChange={(e) =>
                change({
                  ...project,
                  design: {
                    ...project.design,
                    height: Number(e.target.value) as 1080 | 1440,
                  },
                })
              }
            >
              <option value={1080}>1080p</option>
              <option value={1440}>1440p</option>
            </select>
          </label>
          <p>
            16:9・60fps・MP4/H.264/AAC320k・Aleo・1行自動縮小・黒stroke。coverと背景はfadeしません。
          </p>
          {(["fadeInFrames", "fadeOutFrames"] as const).map((k) => (
            <label key={k}>
              {k}
              <input
                type="number"
                min={0}
                step={1}
                value={project.design[k]}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isSafeInteger(n) && n >= 0)
                    change({
                      ...project,
                      design: { ...project.design, [k]: n },
                    });
                }}
              />
            </label>
          ))}
          <p>
            fade合計{" "}
            {(project.design.fadeInFrames + project.design.fadeOutFrames) / 60}{" "}
            秒（初期0.30秒）。短い区間は自動調整しません。
          </p>
        </>
      )}
      {step === 4 && (
        <section aria-label="検証済み全長preview">
          <p>生成した全長previewを、そのままMP4の書き出しに使えます。</p>
          <button
            disabled={issues.length > 0 || !owner}
            onClick={() => void exportVideo()}
          >
            全長previewを生成
          </button>
          {batch && (
            <>
              <p>{status}</p>
              <button onClick={() => void check()}>
                全長previewの状態を確認
              </button>
            </>
          )}
          {output && (
            <video
              ref={finalVideo}
              aria-label="検証済み全長動画"
              controls
              playsInline
              preload="metadata"
              src={output}
              style={{ width: "100%", aspectRatio: "16/9" }}
              onTimeUpdate={() => {
                finalPosition.current = finalVideo.current?.currentTime ?? 0;
              }}
              onError={() => void check()}
              onLoadedMetadata={() => {
                if (finalVideo.current)
                  finalVideo.current.currentTime = finalPosition.current;
              }}
            />
          )}
        </section>
      )}
      {step === 5 && (
        <>
          <p>
            全長：{versions.at(-1)?.endFrame ?? 0} frames・version数：
            {versions.length}
          </p>
          <button
            disabled={!owner || issues.length > 0}
            onClick={() => void exportVideo()}
          >
            全長を書き出す
          </button>
          {batch && (
            <>
              <p>
                job：{batch} ／ {status}
              </p>
              <button onClick={() => void check()}>進捗・結果を確認</button>
            </>
          )}
          {output && (
            <a href={output} rel="noreferrer">
              検証済みMP4を保存
            </a>
          )}
        </>
      )}
      {issues.length > 0 && (
        <ul aria-label="検出事項">
          {issues.map((code) => (
            <li key={code}>{messages[code] ?? code}</li>
          ))}
        </ul>
      )}
      <style>
        {
          "button,input,select {min-height:44px} textarea{display:block;width:100%;} fieldset{margin-top:12px;} button{cursor:pointer;} input{max-width:100%;} main{overflow-wrap:anywhere;}"
        }
      </style>
    </main>
  );
}
export default AllVersionsEditor;
