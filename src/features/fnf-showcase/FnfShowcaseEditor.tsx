"use client";
/* eslint-disable @next/next/no-img-element -- The private server-rasterized overlay must remain a native, unoptimized PNG. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createVideoApiClient,
  currentVideoSessionSource,
  videoStateMessage,
} from "../../services/video/api-client";
import {
  cloudClient,
  type AuthenticatedApi,
} from "../../services/cloud-library/client";
import { fnfClient, type FnfBatchView } from "../../services/video/fnf-client";
import { FnfSession } from "../../services/video/fnf-session";
import {
  defaultFnfPreferences,
  fnfPreferencesSchema,
  fnfFilenames,
  type FnfPreferences,
  type FnfShowcaseSnapshot,
} from "../../domain/video/fnf-showcase";
import {
  loadFnfPreferences,
  saveFnfPreferences,
} from "../../services/developer-storage/fnf-preferences";
import CloudLibrary from "../developer/CloudLibrary";
import {
  VideoPreview,
  type PreviewResolver,
} from "../video-common/VideoPreview";
import { TimeField } from "../video-common/TimeField";
import { PlaybackError } from "../../services/video/playback";
import type { CloudAsset } from "../../domain/cloud-library/media";
import { z } from "zod";
import { watchOwner } from "../../services/local-encoding/session";
import { LocalEncodingPanel } from "../local-encoding/LocalEncodingPanel";
import {
  importMedia,
  localPreview,
  releaseMedia,
} from "../../services/local-encoding/media";
import { localOverlay } from "../../services/local-encoding/graphics";
import { cacheCloudSource } from "../../services/local-encoding/cloud-source";
const serverEncodingAvailable = false;
const templateLabels = {
  presetWidth: "固定preset幅(px)",
  presetHeight: "固定preset高さ(px)",
  cropTop: "上crop(px)",
  cropBottom: "下crop(px)",
  scale: "固定scaling倍率",
};
const errors: Record<string, string> = {
  FNF_INVALID_RANGE: "無効な区間です。rangeは変更していません。",
  FNF_EMPTY_NAME: "すべてのrangeに譜面名を入力してください。",
  FNF_INVALID_CROP: "crop後の高さまたはscalingが無効です。",
  FNF_PREFERENCES_CONFLICT:
    "設定が409で競合しました。端末の設定は保持しています。",
  FNF_SOURCE_MISSING: "検証済み動画が見つかりません。",
  FNF_FONT_UNAVAILABLE: "固定fontを使用できません。",
  AUTH_REQUIRED:
    "ログインしてください。受付済みjobはserver側で保持されています。",
  HTTP_403: "開発者権限を確認できません。",
  HTTP_503: "受付は保留中です。同じキーで再確認できます。",
  AUTH_EXPIRED: "認証の期限が切れました。受付済みjobは継続します。",
  PROXY_NOT_READY: "proxyは準備中です。後で素材をもう一度選択してください。",
  INVALID_INTERVAL: "無効な時刻です。",
  REQUEST_FAILED:
    "接続できません。受付が不明な場合は受付済batch一覧を確認してください。",
};
export function FnfShowcaseEditor({
  api: injected,
}: {
  api?: AuthenticatedApi;
}) {
  const enabled =
    !!injected ||
    process.env.NEXT_PUBLIC_FNF_SHOWCASE_ENABLED === "true" ||
    process.env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED === "true";
  const api = useMemo(() => {
    if (injected) return injected;
    if (!enabled) return null;
    const baseUrl =
        process.env.NEXT_PUBLIC_DEVELOPER_AUTH_API_ORIGIN ??
        process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN,
      session = currentVideoSessionSource();
    if (!baseUrl || !session) return null;
    try {
      return createVideoApiClient({ baseUrl, session });
    } catch {
      return null;
    }
  }, [enabled, injected]);
  const [owner, setOwner] = useState<string | null>(null),
    [preferences, setPreferences] = useState(defaultFnfPreferences),
    [preferenceStatus, setPreferenceStatus] = useState("設定は未保存"),
    [prefRevision, setPrefRevision] = useState(0),
    [preferencesReady, setPreferencesReady] = useState(false),
    [prefSaving, setPrefSaving] = useState(false),
    [session, setSession] = useState<FnfSession | null>(null),
    [draftRevision, setDraftRevision] = useState(0),
    [clock, setClock] = useState(0),
    [png, setPng] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [batch, setBatch] = useState<FnfBatchView | null>(null),
    [history, setHistory] = useState<{ id: string; createdAt: string }[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [batchId, setBatchId] = useState(""),
    [access, setAccess] = useState<Record<string, string>>({}),
    [progress, setProgress] = useState<
      Record<
        string,
        {
          completedFrames: number;
          totalFrames: number;
          runs: number;
          errorCode?: string | null;
        }
      >
    >({}),
    [cardPage, setCardPage] = useState(0);
  const dirty = useRef(false),
    preferenceGeneration = useRef(0),
    active = useRef(true),
    pending = useRef<{
      snapshot: FnfShowcaseSnapshot;
      key: string;
      fingerprint: string;
    } | null>(null),
    submitted = useRef(""),
    busyRef = useRef(false),
    batchRequest = useRef(0),
    sourceRequest = useRef(0),
    prefSavingRef = useRef(false);
  const cloud = useMemo(
      () =>
        api && (injected || process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN)
          ? cloudClient(api)
          : null,
      [api, injected],
    ),
    client = useMemo(
      () => (api && owner ? fnfClient(api, owner) : null),
      [api, owner],
    );
  useEffect(() => {
    if (owner && !injected) return watchOwner(owner, () => setOwner(null));
  }, [owner, injected]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    setOwner(null);
    if (!api) return;
    let live = true;
    void api.me().then((r) => {
      if (live) {
        if (r.ok) setOwner(r.data.ownerId);
        else setError(r.code);
      }
    });
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => {
    if (!owner) return;
    let live = true;
    setPreferencesReady(false);
    void (async () => {
      const local = await loadFnfPreferences(owner);
      if (live && local && !dirty.current) setPreferences(local);
    })()
      .catch(() => {
        if (live) setPreferenceStatus("端末設定を読み込めませんでした。");
      })
      .finally(() => {
        if (live) setPreferencesReady(true);
      });
    return () => {
      live = false;
    };
  }, [owner]);
  useEffect(() => {
    if (!owner) return;
    let live = true,
      url = "";
    setPng("");
    const valid = fnfPreferencesSchema.safeParse(preferences);
    if (valid.success)
      void localOverlay(valid.data)
        .then((blob) => {
          if (live) {
            url = URL.createObjectURL(blob);
            setPng(url);
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [owner, preferences]);
  useEffect(
    () => () => {
      if (owner) releaseMedia(owner);
    },
    [owner],
  );

  const change = (next: FnfPreferences) => {
    if (busyRef.current || pending.current) return;
    dirty.current = true;
    preferenceGeneration.current++;
    setPreferences(next);
    setPreferenceStatus("設定は未保存");
    setError("");
  };
  async function savePreferences() {
    if (!owner || prefSavingRef.current) return;
    prefSavingRef.current = true;
    setPrefSaving(true);
    try {
      const clean = fnfPreferencesSchema.parse(preferences),
        generation = preferenceGeneration.current;
      await saveFnfPreferences(owner, clean);
      setPreferenceStatus("端末に設定保存済み・cloud未保存");
      if (!client || (!injected && !process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN)) {
        setPreferenceStatus("端末に設定保存済み");
        dirty.current = false;
        return;
      }
      const r = await client.savePreferences(clean, prefRevision);
      if (!active.current) return;
      if (r.ok) setPrefRevision(r.data.revision);
      if (generation !== preferenceGeneration.current) return;
      if (!r.ok) {
        setError(r.code);
        return;
      }
      setPrefRevision(r.data.revision);
      setPreferenceStatus("端末／cloudに設定保存済み");
      dirty.current = false;
    } catch {
      setError(
        "設定または端末の保存状態を確認してください。rangeと譜面名は保存していません。",
      );
    } finally {
      prefSavingRef.current = false;
      if (active.current) setPrefSaving(false);
    }
  }
  async function loadCloudPreferences() {
    if (!client || prefSavingRef.current || busyRef.current || pending.current)
      return;
    const request = ++preferenceGeneration.current;
    const r = await client.preferences();
    if (!active.current || request !== preferenceGeneration.current) return;
    if (!r.ok) {
      setError(r.code);
      return;
    }
    setPreferences(r.data.preferences);
    setPrefRevision(r.data.revision);
    dirty.current = false;
    setPreferenceStatus("cloud設定を読込済み・端末への保存は別操作です");
  }
  const resolve: PreviewResolver = useCallback(
    async (ref) => {
      if (ref.libraryId === "local" && owner) return localPreview(owner, ref);
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
    [cloud, owner],
  );
  async function select(asset: CloudAsset) {
    if (!client || asset.kind !== "video") {
      setError("動画を選択してください。");
      return;
    }
    if (
      busyRef.current ||
      pending.current ||
      session?.source.reference.versionId === asset.versionId
    )
      return;
    const request = ++sourceRequest.current;
    try {
      const r = await client.source(asset.versionId);
      if (!r.ok) throw new Error(r.code);
      await resolve(r.data.reference);
      if (!active.current || request !== sourceRequest.current) return;
      setSession(new FnfSession(r.data));
      setClock(0);
      setDraftRevision((v) => v + 1);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "FNF_SOURCE_MISSING");
    }
  }
  async function loadLocal(file: File) {
    if (!owner || locked) return;
    try {
      const media = await importMedia(owner, file, "video");
      setSession(
        new FnfSession({
          reference: media.reference,
          durationUs: media.durationUs,
          width: media.width,
          height: media.height,
          geometryVerified: true,
        }),
      );
      setClock(0);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "動画を読み込めません。");
    }
  }
  async function authorize() {
    const result = await api?.me();
    const allowed = !!result?.ok && result.data.ownerId === owner;
    if (!allowed) setOwner(null);
    return allowed;
  }
  const update = (work: () => void) => {
    if (busyRef.current || pending.current) return;
    try {
      work();
      setDraftRevision((v) => v + 1);
      setError("");
    } catch {
      setError("FNF_INVALID_RANGE");
    }
  };
  async function refresh(id = batch?.batch.id ?? batchId, page = cardPage) {
    if (!client || !id) return;
    const request = ++batchRequest.current;
    const r = await client.batch(id);
    if (!active.current || request !== batchRequest.current) return;
    if (!r.ok) {
      setError(r.code);
      return;
    }
    setBatch(r.data);
    setBatchId(id);
    const nextPage = batch?.batch.id === id ? page : 0;
    setCardPage(nextPage);
    const jobs = r.data.items
      .slice(nextPage * 20, (nextPage + 1) * 20)
      .map(
        (item) =>
          r.data.batch.jobs
            .filter((j) => j.rangeIndex === item.rangeIndex)
            .sort((a, b) => b.attempt - a.attempt)[0],
      )
      .filter(Boolean);
    const values = await Promise.all(jobs.map((j) => client.progress(j.id)));
    if (!active.current || request !== batchRequest.current) return;
    setProgress(
      Object.fromEntries(
        values
          .filter((r) => r.ok)
          .map((r) => (r.ok ? [r.data.jobId, r.data] : [])),
      ),
    );
  }
  async function list(more = false) {
    if (!client) return;
    const r = await client.batches(more ? (cursor ?? undefined) : undefined);
    if (r.ok && active.current) {
      setHistory((old) => (more ? [...old, ...r.data.items] : r.data.items));
      setCursor(r.data.nextCursor);
    } else if (!r.ok) setError(r.code);
  }
  async function submit() {
    if (!client || !session || busyRef.current || !preferencesReady) return;
    try {
      if (!pending.current) {
        const snapshot = session.snapshot(preferences);
        pending.current = {
          snapshot,
          key: crypto.randomUUID(),
          fingerprint: JSON.stringify({
            ranges: session.ranges,
            source: session.source,
            preferences,
          }),
        };
      }
      busyRef.current = true;
      setBusy(true);
      const r = await client.submit(
        pending.current.snapshot,
        pending.current.key,
      );
      if (!active.current) return;
      if (!r.ok) {
        setError(r.code);
        const ambiguous =
          r.code === "REQUEST_FAILED" ||
          r.code === "INVALID_RESPONSE" ||
          /^HTTP_5/.test(r.code) ||
          ["auth-expired", "unauthenticated", "held"].includes(r.state);
        if (!ambiguous) pending.current = null;
        return;
      }
      submitted.current = pending.current.fingerprint;
      pending.current = null;
      await refresh(r.data.id);
      await list();
      setError("");
    } catch {
      setError(
        pending.current
          ? "REQUEST_FAILED"
          : session.ranges.some((r) => !r.name.trim())
            ? "FNF_EMPTY_NAME"
            : "FNF_INVALID_RANGE",
      );
    } finally {
      busyRef.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function retry(id: string) {
    if (!api || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const r = await api.retry(id, crypto.randomUUID());
    if (!r.ok) setError(r.code);
    await refresh();
    busyRef.current = false;
    setBusy(false);
  }
  async function saveUrl(output: string) {
    if (!api) return;
    const r = await api.request(
      `/render-outputs/${output}/access`,
      z.object({
        url: z.string(),
        expiresAt: z.number(),
        hash: z.string(),
        size: z.number(),
      }),
    );
    if (r.ok) setAccess((old) => ({ ...old, [output]: r.data.url }));
    else setError(r.code);
  }
  const names = fnfFilenames(session?.sorted().map((r) => r.name) ?? []),
    fingerprint = JSON.stringify({
      ranges: session?.ranges,
      source: session?.source,
      preferences,
    }),
    locked = busy || !!pending.current;
  const width = session
      ? Math.floor((session.source.width * preferences.template.scale) / 2) * 2
      : 1080,
    cropped = session
      ? Math.floor(
          ((session.source.height -
            preferences.template.cropTop -
            preferences.template.cropBottom) *
            preferences.template.scale) /
            2,
        ) * 2
      : 608,
    sourceHeight = session
      ? session.source.height * preferences.template.scale
      : 608;
  const mismatch =
    session &&
    (!session.source.geometryVerified ||
      session.source.width !== preferences.template.presetWidth ||
      session.source.height !== preferences.template.presetHeight);
  if (!enabled)
    return (
      <main>
        <h1>FNF Showcase Maker</h1>
        <p>入口はOFFです。受付jobと完成物は保持されています。</p>
      </main>
    );
  if (!api)
    return (
      <main>
        <h1>FNF Showcase Maker</h1>
        <p>開発者APIとログインを設定してください。</p>
      </main>
    );
  if (!owner)
    return (
      <main>
        <h1>FNF Showcase Maker</h1>
        <p role="status">開発者権限を確認しています。{error}</p>
      </main>
    );
  return (
    <main
      style={{
        maxWidth: 1100,
        margin: "auto",
        padding: 16,
        overflowWrap: "anywhere",
      }}
    >
      <h1>FNF Showcase Maker</h1>
      <p>
        編集中のrange・譜面名はメモリー内です。書き出しキューに追加すると端末に保存されます。端末内処理には画面を開いたままにしてください。
      </p>
      {error && <p role="alert">{errors[error] ?? error}</p>}
      <fieldset disabled={locked}>
        <legend>次回用設定（templateとusernameだけ保存）</legend>
        <label>
          @username
          <input
            value={preferences.username}
            onChange={(e) =>
              change({ ...preferences, username: e.target.value })
            }
          />
        </label>
        {(
          [
            "presetWidth",
            "presetHeight",
            "cropTop",
            "cropBottom",
            "scale",
          ] as const
        ).map((k) => (
          <label key={k}>
            {templateLabels[k]}
            <input
              type="number"
              value={preferences.template[k]}
              min={k === "scale" ? 0.01 : 0}
              step={k === "scale" ? 0.001 : 1}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n))
                  change({
                    ...preferences,
                    template: { ...preferences.template, [k]: n },
                  });
              }}
            />
          </label>
        ))}
        <button
          disabled={prefSaving || !preferencesReady}
          onClick={() => void savePreferences()}
        >
          template・usernameを保存
        </button>
        <button
          disabled={prefSaving}
          onClick={() => void loadCloudPreferences()}
        >
          cloud設定を読み込む（編集中設定を置換）
        </button>
        <p role="status" aria-label="設定保存状態">
          {preferenceStatus}
        </p>
      </fieldset>
      {mismatch && (
        <p role="alert">
          元寸法 {session.source.width}×{session.source.height}{" "}
          は固定presetと異なるか、表示寸法が未検証です。設定は自動変更していません。
          <button
            disabled={locked}
            onClick={() =>
              change({
                ...preferences,
                template: {
                  ...preferences.template,
                  presetWidth: session.source.width,
                  presetHeight: session.source.height,
                  scale: 1080 / session.source.width,
                },
              })
            }
          >
            現在寸法で幅いっぱいに合わせる
          </button>
        </p>
      )}
      <label>
        端末から元動画を読み込む
        <input
          disabled={locked}
          type="file"
          accept="video/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void loadLocal(file);
            e.target.value = "";
          }}
        />
      </label>
      <details>
        <summary>クラウド素材を選択／upload（任意）</summary>
        {cloud && (
          <CloudLibrary
            client={cloud}
            onSelect={(asset) => void select(asset)}
          />
        )}
      </details>
      {session && (
        <>
          <VideoPreview
            key={session.source.reference.versionId}
            mode="fnf"
            document={session.document()}
            onDocumentChange={() => {}}
            resolve={resolve}
            onTimeChange={setClock}
            fnfRanges={session.ranges}
            fnfAddDurationUs={30_000_000}
            onFnfRangesChange={(ranges) => update(() => session.adopt(ranges))}
            videoStyle={{ objectFit: "fill" }}
            mediaFrame={(node) => (
              <div
                style={{
                  position: "absolute",
                  width: `${(width / 1080) * 100}%`,
                  height: `${(Math.max(0, cropped) / 1920) * 100}%`,
                  left: "50%",
                  top: "50%",
                  transform: "translate(-50%,-50%)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    top: `${((-preferences.template.cropTop * preferences.template.scale) / Math.max(1, cropped)) * 100}%`,
                    height: `${(sourceHeight / Math.max(1, cropped)) * 100}%`,
                  }}
                >
                  {node}
                </div>
              </div>
            )}
            overlay={
              png ? (
                <img
                  alt="固定文字とusername・fadeなし"
                  src={png}
                  style={{ width: "100%", height: "100%" }}
                />
              ) : undefined
            }
          />
          <fieldset disabled={locked}>
            <legend>range・個別譜面名（未送信）</legend>
            <button
              onClick={() =>
                update(() => {
                  session.addAt(clock);
                })
              }
            >
              現在位置から30秒rangeを追加
            </button>
            {session.ranges.map((r, i) => (
              <div key={r.id}>
                <TimeField
                  label={`range ${i + 1} 全体を開始時刻へ移動`}
                  value={r.startUs}
                  onCommit={(us) => update(() => session.move(r.id, us))}
                  onError={() => setError("FNF_INVALID_RANGE")}
                />
                <button onClick={() => update(() => session.remove(r.id))}>
                  range {i + 1} を削除
                </button>
              </div>
            ))}
            <p>開始時刻順のfilename（同開始は作成順）：</p>
            <ol>
              {session.sorted().map((r, i) => (
                <li key={r.id}>
                  {r.name || "（譜面名未入力）"} → {names[i]}
                </li>
              ))}
            </ol>
            {serverEncodingAvailable && (
              <button
                disabled={
                  !owner ||
                  busy ||
                  !session.ranges.length ||
                  (!pending.current && submitted.current === fingerprint)
                }
                onClick={() => void submit()}
              >
                {pending.current ? "前回受付結果を再確認" : "全rangeを一括受付"}
              </button>
            )}
          </fieldset>
        </>
      )}
      <LocalEncodingPanel
        owner={owner}
        snapshot={() => {
          if (!session) throw Error("元動画を読み込んでください。");
          return session.snapshot(preferences);
        }}
        authorize={authorize}
        materialize={
          cloud ? (ref) => cacheCloudSource(owner, ref, cloud) : undefined
        }
      />
      {serverEncodingAvailable && pending.current && !busy && (
        <button onClick={() => void submit()}>
          同じ内容・同じキーで受付を再確認
        </button>
      )}
      <details>
        <summary>既存のServer Encodingジョブ・完成物（保持）</summary>
        <section aria-label="受付済みbatch">
          <h2>batch進捗・各MP4</h2>
          <button onClick={() => void list()}>受付済batch一覧を確認</button>
          <ul>
            {history.map((h) => (
              <li key={h.id}>
                <button onClick={() => void refresh(h.id)}>
                  {h.createdAt}・{h.id}
                </button>
              </li>
            ))}
          </ul>
          {cursor && (
            <button onClick={() => void list(true)}>batchをさらに表示</button>
          )}
          <label>
            batch ID
            <input
              value={batchId}
              onChange={(e) => setBatchId(e.target.value)}
            />
          </label>
          <button onClick={() => void refresh(batchId)}>進捗を再確認</button>
          {batch &&
            batch.items
              .slice(cardPage * 20, (cardPage + 1) * 20)
              .map((item) => {
                const latest = batch.batch.jobs
                    .filter((j) => j.rangeIndex === item.rangeIndex)
                    .sort((a, b) => b.attempt - a.attempt)[0],
                  output = batch.batch.outputs.find(
                    (o) => o.jobId === latest?.id,
                  );
                return (
                  <article
                    key={item.rangeIndex}
                    style={{ border: "1px solid #777", padding: 12, margin: 8 }}
                  >
                    <h3>{item.chartName}</h3>
                    <p>
                      {item.filename} ／{" "}
                      {latest
                        ? videoStateMessage[
                            latest.state === "queued" ||
                            latest.state === "cancel_requested"
                              ? "waiting"
                              : latest.state === "interrupted"
                                ? "failed"
                                : latest.state
                          ]
                        : "待機"}
                    </p>
                    {latest && progress[latest.id] && (
                      <p>
                        {progress[latest.id].completedFrames} /{" "}
                        {progress[latest.id].totalFrames} frames（worker試行{" "}
                        {progress[latest.id].runs}）
                        {progress[latest.id].errorCode
                          ? `・${progress[latest.id].errorCode}`
                          : ""}
                      </p>
                    )}
                    {latest &&
                      ["failed", "cancelled", "interrupted"].includes(
                        latest.state,
                      ) && (
                        <button
                          disabled={busy}
                          onClick={() => void retry(latest.id)}
                        >
                          この失敗rangeだけretry
                        </button>
                      )}
                    {output && (
                      <>
                        <button onClick={() => void saveUrl(output.id)}>
                          MP4保存URLを取得・更新
                        </button>
                        {access[output.id] && (
                          <a
                            href={access[output.id]}
                            download={item.filename}
                            rel="noreferrer"
                          >
                            {item.filename}を保存
                          </a>
                        )}
                      </>
                    )}
                  </article>
                );
              })}
          {batch && batch.items.length > 20 && (
            <div>
              <button
                disabled={cardPage === 0}
                onClick={() => void refresh(batch.batch.id, cardPage - 1)}
              >
                前のMP4カード
              </button>
              <span>
                {cardPage + 1} / {Math.ceil(batch.items.length / 20)}
              </span>
              <button
                disabled={(cardPage + 1) * 20 >= batch.items.length}
                onClick={() => void refresh(batch.batch.id, cardPage + 1)}
              >
                次のMP4カード
              </button>
            </div>
          )}
        </section>
      </details>
      <style>
        {
          "button,input {min-height:44px} label{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px} input{max-width:100%} fieldset{margin:12px 0} main{overflow-wrap:anywhere}"
        }
      </style>
      <span hidden>{draftRevision}</span>
    </main>
  );
}
export default FnfShowcaseEditor;
