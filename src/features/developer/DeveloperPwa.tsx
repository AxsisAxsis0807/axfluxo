"use client";
import { useState } from "react";
import { z } from "zod";
import type { AuthenticatedApi } from "../../services/cloud-library/client";
const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export default function DeveloperPwa({ api }: { api: AuthenticatedApi }) {
  const [registration, setRegistration] =
      useState<ServiceWorkerRegistration | null>(null),
    [publicKey, setPublicKey] = useState<string | null>(null),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  async function setup() {
    setBusy(true);
    try {
      if (!("serviceWorker" in navigator)) throw Error();
      const reg = await navigator.serviceWorker.register(
        `${base}/developer-sw.js`,
        { scope: `${base}/developer/`, updateViaCache: "none" },
      );
      setRegistration(reg);
      setStatus(
        "Safariでは共有→ホーム画面に追加してください。通知は別の明示操作で許可します。",
      );
      const config = await api.request(
        "/push/config",
        z.object({ enabled: z.boolean(), publicKey: z.string().nullable() }),
      );
      setPublicKey(
        config.ok && config.data.enabled ? config.data.publicKey : null,
      );
      if (!config.ok || !config.data.enabled)
        setStatus("PWAを準備しました。通知受付は停止中です。");
      reg.addEventListener("updatefound", () => {
        reg.installing?.addEventListener("statechange", () => {
          if (reg.waiting)
            setStatus(
              "更新があります。作業を保存してから更新を有効にしてください。",
            );
        });
      });
    } catch {
      setStatus("PWAを準備できませんでした。通常のMP4保存は利用できます。");
    } finally {
      setBusy(false);
    }
  }
  async function subscribe() {
    // Request permission immediately within this explicit click, before any network await.
    if (
      !registration ||
      !("Notification" in window) ||
      !("PushManager" in window)
    ) {
      setStatus("ホーム画面PWAと通知対応端末が必要です。");
      return;
    }
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("通知は許可されていません。完成動画は一覧に保持されます。");
        return;
      }
      if (!publicKey) return;
      const raw = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")),
        key = new Uint8Array([...raw].map((v) => v.charCodeAt(0)));
      const sub =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        }));
      const data = sub.toJSON(),
        r = await api.request(
          "/push/subscribe",
          z.object({ subscribed: z.boolean() }),
          "POST",
          { endpoint: sub.endpoint, keys: data.keys },
          crypto.randomUUID(),
        );
      setStatus(
        r.ok
          ? "完了・一部失敗の通知を登録しました。"
          : "購読を保存できませんでした。再登録してください。",
      );
    } catch {
      setStatus("通知登録に失敗しました。完成動画は保持されます。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h2>ホーム画面・通知</h2>
      <p>iPhoneではホーム画面に追加したPWAで通知を許可してください。</p>
      <button disabled={busy} onClick={() => void setup()}>
        開発者PWAを準備
      </button>
      <button
        disabled={busy || !registration || !publicKey}
        onClick={() => void subscribe()}
      >
        通知を許可・登録
      </button>
      <button
        disabled={busy || !registration}
        onClick={() => {
          void (async () => {
            try {
              const sub = await registration?.pushManager.getSubscription();
              if (sub) {
                const result = await api.request(
                  "/push/unsubscribe",
                  z.object({ subscribed: z.boolean() }),
                  "POST",
                  { endpoint: sub.endpoint },
                  crypto.randomUUID(),
                );
                if (!result.ok) throw Error();
                await sub.unsubscribe();
              }
              setStatus("通知購読を解除しました。");
            } catch {
              setStatus("解除を完了できませんでした。再試行してください。");
            }
          })();
        }}
      >
        通知を解除
      </button>
      <button
        disabled={!registration?.waiting}
        onClick={() => {
          registration?.waiting?.postMessage("ACTIVATE_UPDATE");
          setStatus("更新を有効にしました。次回開き直した際に使用します。");
        }}
      >
        保存後にSW更新を有効化
      </button>
      <p role="status">{status}</p>
    </section>
  );
}
