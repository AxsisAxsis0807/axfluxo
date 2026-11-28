"use client";
import { LocalExport } from "../video-common/LocalExport";
import { buildCloudLocalJobs, type RecoverableLocalJob } from "../../services/video/cloud-local-job";
import {
  imageForEncode,
} from "../../services/video/local-encode";
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
import { PlaybackError } from "../../services/video/playback";
import {
  ALL_VERSIONS_COVER_RADIUS_RATIO,
  ALL_VERSIONS_REFERENCE as REF,
  referenceTimerText,
} from "../../domain/video/all-versions-reference";
import { drawReferenceFrame, loadReferenceFonts, referenceArtwork, referenceCanvasTitle } from "../../services/video/all-versions-canvas";
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
  PROJECT_CONFLICT: "書き出し設定の保存が競合しました。",
  FONT_GLYPH_UNSUPPORTED:
    "Aleoで描画できない文字があります。代替fontに変更していません。",
  FONT_UNAVAILABLE: "固定fontを使用できません。",
  AUTH_EXPIRED: "認証の期限が切れました。",
  AUTH_REQUIRED: "ログインしてください。",
  REQUEST_FAILED:
    "接続できません。画面の編集内容を確認して再試行できます。",
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
    [error, setError] = useState(""),
    [clock, setClock] = useState(0),
    [coverUrl, setCoverUrl] = useState(""),
    [text, setText] = useState<{ key: string; url: string } | null>(null),
    [batch, setBatch] = useState(""),
    [status, setStatus] = useState(""),
    [output, setOutput] = useState("");
  const remote = useMemo(
    () => (api && owner ? projectsClient(api, owner) : null),
    [api, owner],
  );
  const submission = useRef<{ key: string; snapshot: AllVersionsProject; revision?: number } | null>(null);
  const submittingExport = useRef(false);
  const docRef = useRef(project),
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
  const change = useCallback((next: AllVersionsProject) => {
    generation.current++;
    setProject(next);
    docRef.current = next;
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
  const referencePreview = useRef<HTMLCanvasElement>(null);
  const [previewArtwork, setPreviewArtwork] = useState<{ url: string; canvas: HTMLCanvasElement } | null>(null);
  const [fontReadyFor, setFontReadyFor] = useState<string[] | null>(null);
  const drawPreviewTitle = useRef<ReturnType<typeof referenceCanvasTitle> | null>(null);
  const reference = project.design.layout === "reference-pasa-v1";
  const { namesText, removeNumbers } = project;
  const names = useMemo(() => projectNames({ namesText, removeNumbers }), [namesText, removeNumbers]);
  const versions = useMemo(() => versionIntervals(project), [project]),
    issues = projectIssues(project),
    frame = toFrame(clock),
    index = Math.max(
      0,
      versions.findIndex((v) => frame >= v.startFrame && frame < v.endFrame),
    );
  const textKey = JSON.stringify({
    index,
    name: names[index],
    design: project.design,
  });
  useEffect(() => {
    let live = true;
    if (!reference && remote && projectNames(docRef.current)[index]?.trim())
      void remote
        .text(docRef.current, index)
        .then((r) => {
          if (live) setText({ key: textKey, url: `data:image/png;base64,${r.png}` });
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [remote, textKey, index, reference]);
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
  const showReference = reference && !!project.document && (step === 1 || step === 4);
  const previewHeight = project.design.height;
  const previewFontReady = fontReadyFor === names;
  useEffect(() => {
    if (!showReference) return;
    let live = true;
    void loadReferenceFonts(names).then(() => {
      if (live) setFontReadyFor(names);
    }).catch((error: unknown) => {
      if (live) setError(error instanceof Error ? error.message : "FONT_UNAVAILABLE");
    });
    return () => { live = false; };
  }, [names, showReference]);
  useEffect(() => {
    if (!showReference || !coverUrl) {
      setPreviewArtwork(null);
      return;
    }
    let live = true;
    void imageForEncode(coverUrl).then((cover) => {
      if (live) setPreviewArtwork({
        url: coverUrl,
        canvas: referenceArtwork(cover, previewHeight * 16 / 9, previewHeight),
      });
    }).catch((e: unknown) => {
      if (live) setError(e instanceof Error ? e.message : "PREVIEW_FAILED");
    });
    return () => { live = false; };
  }, [coverUrl, previewHeight, showReference]);
  useEffect(() => {
    drawPreviewTitle.current = showReference && previewFontReady
      ? referenceCanvasTitle(names) : null;
  }, [names, previewFontReady, showReference]);
  useEffect(() => {
    const canvas = referencePreview.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !showReference) return;
    if (previewArtwork?.url !== coverUrl || previewArtwork.canvas.height !== previewHeight) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (drawPreviewTitle.current) {
      drawReferenceFrame(ctx, previewArtwork.canvas, frame, versions, project.design, drawPreviewTitle.current);
    } else ctx.drawImage(previewArtwork.canvas, 0, 0);
  }, [coverUrl, frame, previewArtwork, previewFontReady, previewHeight, project.design, showReference, versions]);
  async function prepareLocal(): Promise<RecoverableLocalJob[]> {
    if (!api || !owner) throw Error("素材と名前を確認してください。");
    return buildCloudLocalJobs({ version: 1, kind: "all-versions", ownerId: owner, index: 0, project }, api);
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
    if (!remote || submittingExport.current) return;
    const key = JSON.stringify(project);
    const pending = submission.current?.key === key
      ? submission.current
      : { key, snapshot: { ...project, id: crypto.randomUUID() } };
    submission.current = pending;
    submittingExport.current = true;
    const request = generation.current;
    try {
      if (pending.revision === undefined) {
        const result = await remote.transport.put(pending.snapshot, 0);
        if ("conflict" in result) throw Error("PROJECT_CONFLICT");
        pending.revision = result.revision;
      }
      const r = await remote.render(pending.snapshot.id, pending.revision);
      if (request !== generation.current) return;
      rendered.current = { key, batch: r.id };
      setBatch(r.id);
      setStatus("待機中");
    } catch (e) {
      if (request === generation.current)
        setError(e instanceof Error ? e.message : "PROJECT_INVALID");
    } finally {
      submittingExport.current = false;
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
      <p>{project.design.layout === "reference-pasa-v1"
        ? "参考動画再現プロファイル：タイトル中央・経過時間・同期フェード（元動画との完全一致は未検証）"
        : "暫定layoutです。参考画像との一致は未検証です。"}</p>
      {error && <p role="alert">{messages[error] ?? error}</p>}
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
            step === 4 || showReference ? (
              <div
                style={{ position: "absolute", inset: 0, background: "black" }}
              >
                {reference && (
                  <canvas
                    ref={referencePreview}
                    width={project.design.height * 16 / 9}
                    height={project.design.height}
                    aria-label="参考レイアウト合成プレビュー"
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                  />
                )}
                {coverUrl && !reference && (
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
                        borderRadius: `${ALL_VERSIONS_COVER_RADIUS_RATIO * 100}%`,
                        left: "50%",
                        top: "12%",
                        transform: "translateX(-50%)",
                      }}
                    />
                  </>
                )}
                {project.design.layout !== "reference-pasa-v1" && <div
                  style={{
                    position: "absolute",
                    left: "5%",
                    right: "5%",
                    top: "78%",
                    height: "15%",
                    background: "rgba(0,0,0,.48)",
                  }}
                />}
                {reference && versions[index] && (
                  <span
                    aria-label="楽曲の経過時間"
                    style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}
                  >
                    {referenceTimerText(frame, versions[index])}
                  </span>
                )}
                {!reference && text?.key === textKey && (
                  <img
                    width={1920}
                    height={1080}
                    alt="server生成の文字"
                    src={text.url}
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
            表示テンプレート
            <select
              value={project.design.layout}
              onChange={(e) => {
                const reference = e.target.value === "reference-pasa-v1";
                change({
                  ...project,
                  design: {
                    ...project.design,
                    layout: reference ? "reference-pasa-v1" : "provisional-v1",
                    fadeInFrames: reference ? REF.fadeInFrames : 9,
                    fadeOutFrames: reference ? REF.fadeOutFrames : 9,
                  },
                });
              }}
            >
              <option value="provisional-v1">従来の暫定レイアウト</option>
              <option value="reference-pasa-v1">参考動画再現（中央文字＋経過時間）</option>
            </select>
          </label>
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
            16:9・60fps・MP4/H.264/AAC320k。参考動画再現は中央のAleo文字＋黒帯・下部のmm:ss表示。文字と時計のfade境界を同期し、背景はfadeしません。
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
            秒（暫定は初期0.30秒、参考動画再現は初期1.60秒）。短い区間は自動調整しません。
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
          <LocalExport
            prepare={prepareLocal}
            disabled={!owner || issues.length > 0}
          />
          <details>
            <summary>サーバーで書き出す</summary>
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
          </details>
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
