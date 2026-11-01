"use client";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createVideoApiClient,
  currentVideoSessionSource,
  type VideoState,
} from "../../services/video/api-client";
import { DeveloperVideoStatus } from "./DeveloperVideoStatus";
type Client = ReturnType<typeof createVideoApiClient>;
/** Static diagnostic host. Every read still passes server-side JWT/membership/owner checks. */
export default function DeveloperVideoPanel({
  client: injected,
}: {
  client?: Client;
}) {
  const origin = process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
  const client = useMemo(() => {
    if (injected) return injected;
    if (!origin) return null;
    const session = currentVideoSessionSource();
    if (!session) return null;
    try {
      return createVideoApiClient({ baseUrl: origin, session });
    } catch {
      return null;
    }
  }, [injected, origin]);
  const [state, setState] = useState<VideoState>(client ? "ready" : "held");
  const [checking, setChecking] = useState(Boolean(client));
  const [authorized, setAuthorized] = useState(false);
  const [batchId, setBatchId] = useState("");
  const [checkGeneration, setCheckGeneration] = useState(0);
  useEffect(() => {
    let current = true;
    if (!client) return;
    setChecking(true);
    setAuthorized(false);
    void client.me().then((result) => {
      if (!current) return;
      setState(result.state);
      setAuthorized(result.ok);
      setChecking(false);
    });
    return () => {
      current = false;
    };
  }, [client, checkGeneration]);
  async function inspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !authorized || checking) return;
    setChecking(true);
    const result = await client.getBatch(batchId.trim());
    setState(result.state);
    setChecking(false);
    if (
      result.state === "auth-expired" ||
      result.state === "forbidden" ||
      result.state === "unauthenticated"
    )
      setAuthorized(false);
  }
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: 24 }}>
      <h1>開発者用動画ジョブ</h1>
      <p>所有するジョブの状態を確認します。</p>
      {checking ? (
        <p role="status">確認しています…</p>
      ) : (
        <DeveloperVideoStatus state={state} />
      )}
      {!client && (
        <p>
          {origin
            ? "開発者APIの設定とログイン状態を確認してください。"
            : "開発者APIは未設定です。"}
        </p>
      )}
      {client && (
        <button
          type="button"
          disabled={checking}
          onClick={() => setCheckGeneration((n) => n + 1)}
        >
          開発者権限を再確認
        </button>
      )}
      {authorized && (
        <form onSubmit={inspect}>
          <label>
            バッチID
            <input
              value={batchId}
              onChange={(event) => {
                setBatchId(event.target.value);
                setState("ready");
              }}
              disabled={checking}
              maxLength={36}
              required
              pattern="[a-fA-F0-9-]{36}"
              autoComplete="off"
            />
          </label>
          <button type="submit" disabled={checking}>
            ジョブの状態を確認
          </button>
        </form>
      )}
      <p>
        <Link href="/">制作画面・ログインへ戻る</Link>
      </p>
    </main>
  );
}
