"use client";
import { useEffect, useState, type ReactNode } from "react";
import { authClient } from "../../services/auth";
import {
  verifyDeveloperAccess,
  type DeveloperEntitlement,
} from "../../services/developer/access";
import Account from "../auth/Account";

// Membership is always checked by the API, never inferred from user metadata.
export function useDeveloperAccess() {
  const [access, setAccess] = useState<DeveloperEntitlement | null>(null);
  const [message, setMessage] = useState("開発者権限を確認しています…");
  useEffect(() => {
    const client = authClient();
    if (!client) {
      setMessage("ログイン設定を確認してください。");
      return;
    }
    let live = true,
      generation = 0;
    let observedUser: string | null | undefined;
    const check = async () => {
      const current = ++generation;
      try {
        const result = await verifyDeveloperAccess();
        if (!live || current !== generation) return;
        setAccess(result);
        setMessage("");
      } catch (error) {
        if (live && current === generation) {
          setAccess(null);
          setMessage(
            error instanceof Error
              ? error.message
              : "開発者権限を確認できません。",
          );
        }
      }
    };
    // Do not await Supabase calls inside its auth callback.
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, session) => {
      generation++;
      const userId = session?.user.id ?? null;
      if (observedUser !== undefined && observedUser !== userId)
        setAccess(null);
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
    const timer = window.setInterval(visible, 45_000);
    return () => {
      live = false;
      generation++;
      subscription.unsubscribe();
      clearInterval(timer);
      window.removeEventListener("pageshow", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  useEffect(() => {
    if (!access) return;
    const timer = setTimeout(
      () => {
        setAccess(null);
        setMessage(
          "開発者権限の再確認が必要です。画面を再読み込みしてください。",
        );
      },
      Math.max(0, Date.parse(access.validUntil) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [access]);
  return { access, message };
}
export function DeveloperStudioEntry() {
  const { access } = useDeveloperAccess();
  if (!access) return null;
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
  children: (access: DeveloperEntitlement) => ReactNode;
}) {
  const { access, message } = useDeveloperAccess();
  return (
    <>
      <Account />
      <a
        href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/`}
        style={{ display: "inline-block", padding: 12, minHeight: 44 }}
      >
        AxFluxoへ戻る
      </a>
      {access ? children(access) : <p role="status">{message}</p>}
    </>
  );
}
