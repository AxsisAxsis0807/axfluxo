"use client";
import { useEffect, useState, type ReactNode } from "react";
import { authClient } from "../../services/auth";
import {
  createVideoApiClient,
  videoStateMessage,
} from "../../services/video/api-client";
import type { AuthenticatedApi } from "../../services/cloud-library/client";
import Account from "../auth/Account";

// Membership is always checked by the API, never inferred from user metadata.
export function useDeveloperAccess() {
  const [api, setApi] = useState<AuthenticatedApi | null>(null);
  const [message, setMessage] = useState("開発者権限を確認しています…");
  useEffect(() => {
    const client = authClient();
    const baseUrl = process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
    if (!client || !baseUrl) {
      setMessage("ログインと開発者APIの設定を確認してください。");
      return;
    }
    let live = true,
      generation = 0;
    let observedUser: string | null | undefined;
    let candidate: AuthenticatedApi;
    try {
      candidate = createVideoApiClient({ session: client.auth, baseUrl });
    } catch {
      setMessage("開発者APIの設定を確認してください。");
      return;
    }
    const check = async () => {
      const current = ++generation;
      try {
        const result = await candidate.me();
        if (!live || current !== generation) return;
        if (result.ok) {
          setApi(candidate);
          setMessage("");
        } else {
          setApi(null);
          setMessage(videoStateMessage[result.state]);
        }
      } catch {
        if (live && current === generation) {
          setApi(null);
          setMessage("権限を確認できません。接続後に再試行してください。");
        }
      }
    };
    // Do not await Supabase calls inside its auth callback.
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, session) => {
      generation++;
      const userId = session?.user.id ?? null;
      if (observedUser !== undefined && observedUser !== userId) setApi(null);
      observedUser = userId;
      setTimeout(() => {
        if (live) void check();
      }, 0);
    });
    const visible = () => {
      if (document.visibilityState === "visible") void check();
    };
    void check();
    window.addEventListener("pageshow", visible);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(visible, 60_000);
    return () => {
      live = false;
      generation++;
      subscription.unsubscribe();
      clearInterval(timer);
      window.removeEventListener("pageshow", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return { api, message };
}
export function DeveloperStudioEntry() {
  const { api } = useDeveloperAccess();
  if (!api) return null;
  return (
    <a
      href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/developer/studio/`}
      style={{
        display: "flex",
        alignItems: "center",
        minHeight: 44,
        padding: "8px 12px",
      }}
    >
      Developer Studio
    </a>
  );
}
export function DeveloperGate({
  children,
}: {
  children: (api: AuthenticatedApi) => ReactNode;
}) {
  const { api, message } = useDeveloperAccess();
  return (
    <>
      <Account />
      <a
        href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/`}
        style={{ display: "inline-block", padding: 12, minHeight: 44 }}
      >
        AxFluxoへ戻る
      </a>
      {api ? children(api) : <p role="status">{message}</p>}
    </>
  );
}
