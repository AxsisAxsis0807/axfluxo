"use client";
import { useState, useRef, useEffect } from "react";
import { z } from "zod";
import { driveStatus, driveFile } from "../../domain/google-drive/schema";
import type { createVideoApiClient } from "../../services/video/api-client";
const base = "/api/integrations/google-drive";
const testText = "AxFluxo Google Drive Phase 1 integrity test\n";
export default function GoogleDrivePanel({
  client,
}: {
  client: ReturnType<typeof createVideoApiClient>;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("接続状態を確認してください。"),
    [connected, setConnected] = useState(false);
  const operation = useRef<string | null>(null);
  useEffect(() => {
    const match = /^#drive-binding=([A-Za-z0-9_-]{43})$/.exec(
      window.location.hash,
    );
    if (match) {
      history.replaceState(
        history.state,
        "",
        window.location.pathname + window.location.search,
      );
      try {
        sessionStorage.setItem("axfluxo.drive.binding", match[1]);
        setMessage(
          "ブラウザを確認しました。「接続・再接続」をもう一度タップしてください。",
        );
      } catch {
        setMessage(
          "ブラウザの一時保存を利用できません。Safariの設定を確認してください。",
        );
      }
    }
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch {
      setMessage(
        "通信または検証に失敗しました。状態を確認して再試行してください。",
      );
    } finally {
      setBusy(false);
    }
  }
  function failure(code: string) {
    const messages: Record<string, string> = {
      DRIVE_RECONNECT_REQUIRED: "Google Driveへの再接続が必要です。",
      DRIVE_QUOTA_EXCEEDED: "Google Driveの空き容量を確認してください。",
      DRIVE_FOLDER_RECOVERY_REQUIRED:
        "専用フォルダの移動・削除を確認し、元の場所へ戻してください。",
      DRIVE_RESOURCE_MISSING:
        "保存先が見つかりません。Driveのゴミ箱・権限を確認してください。",
      DRIVE_ACCOUNT_MISMATCH:
        "初回接続と同じGoogleアカウントで接続してください。",
      DRIVE_RETRY_LATER:
        "Google側が混雑しています。時間をおいて再試行してください。",
    };
    setMessage(
      messages[code] ??
        "操作に失敗しました。ログイン・開発者権限・サーバー設定を確認してください。",
    );
  }
  return (
    <section aria-label="Google Drive連携">
      <h2>Google Drive連携（Phase 1）</h2>
      <p>
        小容量テスト用です。専用フォルダとファイルは接続解除後も保持されます。
      </p>
      <p role="status">{message}</p>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const result = await client.request(base + "/status", driveStatus);
            if (!result.ok) {
              failure(result.code);
              return;
            }
            setConnected(result.data.connected);
            setMessage(
              result.data.connected
                ? "接続済みです。フォルダ確認でGoogle側の状態を確認できます。"
                : "未接続です。",
            );
          })
        }
      >
        接続状態を確認
      </button>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const origin = process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
            if (!origin) throw Error();
            const binding = sessionStorage.getItem("axfluxo.drive.binding");
            if (!binding) {
              window.location.assign(new URL(base + "/prepare", origin).href);
              return;
            }
            const result = await client.request(
              base + "/connect",
              z.object({ url: z.string().url() }),
              "POST",
              { binding },
              crypto.randomUUID(),
            );
            if (!result.ok) {
              failure(result.code);
              return;
            }
            const target = new URL(result.data.url);
            if (
              !origin ||
              target.origin !== new URL(origin).origin ||
              target.pathname !== base + "/start"
            )
              throw Error();
            sessionStorage.removeItem("axfluxo.drive.binding");
            window.location.assign(target.href);
          })
        }
      >
        接続・再接続
      </button>
      <button
        disabled={busy || !connected}
        onClick={() =>
          void run(async () => {
            const result = await client.request(
              base + "/folders",
              z.object({
                rootId: z.string(),
                queueId: z.string(),
                completedId: z.string(),
              }),
              "POST",
              {},
              crypto.randomUUID(),
            );
            if (!result.ok) {
              failure(result.code);
              return;
            }
            setMessage("専用フォルダを確認しました。");
          })
        }
      >
        専用フォルダを確認
      </button>
      <button
        disabled={busy || !connected}
        onClick={() =>
          void run(async () => {
            operation.current ??= crypto.randomUUID();
            const saved = await client.request(
              base + "/files",
              driveFile,
              "POST",
              { operationId: operation.current, base64: btoa(testText) },
              operation.current,
            );
            if (!saved.ok) {
              failure(saved.code);
              return;
            }
            const downloaded = await client.request(
              base + "/files/" + encodeURIComponent(saved.data.fileId),
              driveFile,
            );
            if (!downloaded.ok) {
              failure(downloaded.code);
              return;
            }
            if (!downloaded.data.base64) throw Error();
            const data = Uint8Array.from(atob(downloaded.data.base64), (c) =>
              c.charCodeAt(0),
            );
            const hash = Array.from(
              new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
              (v) => v.toString(16).padStart(2, "0"),
            ).join("");
            if (
              hash !== saved.data.sha256 ||
              data.length !== saved.data.size ||
              new TextDecoder().decode(data) !== testText
            )
              throw Error();
            setMessage(
              "保存・取得・サイズ・SHA-256の一致を確認しました。ファイルID: " +
                saved.data.fileId,
            );
          })
        }
      >
        テストファイルを保存・取得・検証
      </button>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const result = await client.request(
              base + "/disconnect",
              z.object({ connected: z.literal(false) }),
              "POST",
              {},
              crypto.randomUUID(),
            );
            if (!result.ok) {
              failure(result.code);
              return;
            }
            setConnected(false);
            setMessage(
              "接続を解除しました。Drive上のファイルは保持されています。",
            );
          })
        }
      >
        接続解除
      </button>
    </section>
  );
}
