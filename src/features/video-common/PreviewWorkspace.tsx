"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createVideoApiClient,
  currentVideoSessionSource,
} from "../../services/video/api-client";
import { cloudClient } from "../../services/cloud-library/client";
import { PlaybackError } from "../../services/video/playback";
import { previewCodeSchema } from "../../domain/video/preview";
import {
  allVersionsDocumentSchema,
  type AllVersionsDocument,
} from "../../domain/video/schema";
import {
  loadVideoDocument,
  saveVideoDocument,
} from "../../services/video/document";
import {
  VideoPreview,
  previewMessages,
  type PreviewResolver,
} from "./VideoPreview";
export default function PreviewWorkspace() {
  const enabled = process.env.NEXT_PUBLIC_VIDEO_PREVIEW_ENABLED === "true",
    client = useMemo(() => {
      if (!enabled || !process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN) return null;
      const session = currentVideoSessionSource();
      if (!session) return null;
      try {
        return cloudClient(
          createVideoApiClient({
            baseUrl: process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN,
            session,
          }),
        );
      } catch {
        return null;
      }
    }, [enabled]);
  const [mode, setMode] = useState<"all-versions" | "fnf">("all-versions"),
    [version, setVersion] = useState(""),
    [doc, setDoc] = useState<AllVersionsDocument | null>(null),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(""),
    [openId, setOpenId] = useState("");
  const queue = useRef(Promise.resolve()),
    revision = useRef(0),
    generation = useRef(0),
    currentId = useRef<string | null>(null);
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get("version");
    if (id) setVersion(id);
  }, []);
  const resolve: PreviewResolver = useCallback(
    async (ref) => {
      if (!client) throw new PlaybackError("AUTH_EXPIRED");
      const result = await client.preview(ref.versionId);
      if (!result.ok) {
        const code = previewCodeSchema.safeParse(result.code);
        throw new PlaybackError(
          result.state === "auth-expired" || result.state === "unauthenticated"
            ? "AUTH_EXPIRED"
            : code.success
              ? code.data
              : "PLAYBACK_FAILED",
        );
      }
      return result.data;
    },
    [client],
  );
  function commit(next: AllVersionsDocument) {
    setDoc(next);
    setError("");
    if (mode !== "all-versions") return;
    const seq = ++generation.current;
    setSaved("保存中…");
    queue.current = queue.current
      .then(async () => {
        if (currentId.current !== next.id) {
          revision.current = next.revision;
          currentId.current = next.id;
        }
        const result = await saveVideoDocument({
          ...next,
          revision: revision.current,
        });
        revision.current = result.revision;
        if (seq === generation.current) {
          setDoc(result);
          setSaved("この端末に保存済み");
        }
      })
      .catch(() => {
        setError(
          "文書を保存できませんでした。競合または保存状態を確認してください。編集状態は保持されています。",
        );
        setSaved("未保存");
      });
  }
  async function add() {
    if (!client) return;
    setError("");
    const result = await client.preview(version.trim());
    if (!result.ok) {
      const code = previewCodeSchema.safeParse(result.code);
      setError(
        code.success
          ? previewMessages[code.data]
          : result.state === "auth-expired"
            ? "認証期限切れです。再ログインしてください。"
            : "previewを準備できませんでした。",
      );
      return;
    }
    const info = result.data,
      clip = {
        id: crypto.randomUUID(),
        source: {
          libraryId: "cloud",
          fileId: info.assetId,
          versionId: info.versionId,
          hash: info.hash,
          kind: "video" as const,
        },
        sourceDurationUs: info.durationUs,
        interval: { startUs: 0, endUs: info.durationUs },
        markersUs: [],
      };
    const base = mode === "all-versions" ? doc : null;
    const next = allVersionsDocumentSchema.safeParse(
      base
        ? { ...base, clips: [...base.clips, clip] }
        : {
            schemaVersion: 1,
            kind: "all-versions",
            id: crypto.randomUUID(),
            revision: 0,
            clips: [clip],
            fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
          },
    );
    if (!next.success) {
      setError(previewMessages.INVALID_INTERVAL);
      return;
    }
    commit(next.data);
  }
  return (
    <main style={{ maxWidth: 1100, margin: "auto", padding: 20 }}>
      <h1>動画preview・非破壊trim</h1>
      {!enabled ? (
        <p role="status">新しいpreview入口は無効です。</p>
      ) : !client ? (
        <p role="status">preview APIが未設定です。</p>
      ) : (
        <>
          <label>
            編集方法
            <select
              value={mode}
              onChange={(e) => {
                generation.current++;
                setMode(e.target.value as typeof mode);
                setDoc(null);
                setSaved("");
              }}
            >
              <option value="all-versions">All Versions（16:9）</option>
              <option value="fnf">FNF（9:16）</option>
            </select>
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <label>
              検証済みversion ID
              <input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                required
                style={{ minHeight: 44 }}
              />
            </label>
            <button style={{ minHeight: 44 }}>素材を追加・proxyを再確認</button>
          </form>
          <p>proxy生成は非同期です。元素材を変更せず、全長を再生します。</p>
          {mode === "all-versions" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void queue.current
                  .then(() => loadVideoDocument(openId.trim()))
                  .then((value) => {
                    if (!value) throw new Error();
                    generation.current++;
                    currentId.current = value.id;
                    revision.current = value.revision;
                    setDoc(value);
                    setSaved("この端末の文書を開きました");
                  })
                  .catch(() => setError("文書を開けませんでした。"));
              }}
            >
              <label>
                保存済み文書ID
                <input
                  value={openId}
                  onChange={(e) => setOpenId(e.target.value)}
                  style={{ minHeight: 44 }}
                />
              </label>
              <button style={{ minHeight: 44 }}>文書を開く</button>
            </form>
          )}
          {doc && (
            <>
              <p>文書ID：{doc.id}</p>
              <VideoPreview
                key={`${mode}:${doc.id}`}
                mode={mode}
                document={doc}
                onDocumentChange={commit}
                resolve={resolve}
              />
            </>
          )}
        </>
      )}
      {saved && <p role="status">{saved}</p>}
      {error && <p role="alert">{error}</p>}
      <p>
        <Link href="/developer/library/">クラウド素材へ</Link> ·{" "}
        <Link href="/">制作画面へ戻る</Link>
      </p>
    </main>
  );
}
