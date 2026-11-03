"use client";
import { useCallback, useEffect, useState, useRef } from "react";
import { authClient } from "../../services/auth";
import {
  createVideoApiClient,
  currentVideoSessionSource,
} from "../../services/video/api-client";
import type { AuthenticatedApi } from "../../services/cloud-library/client";
import {
  checkDeveloper,
  type DeveloperAccessState,
} from "../../services/video/developer-access";
import {
  unavailableDeveloperServices,
  type DeveloperServices,
} from "../../../server/contracts/developer-services";
export function useDeveloperAccess(enabled: boolean) {
  const [state, setState] = useState<DeveloperAccessState>(
      enabled ? "checking" : "disabled",
    ),
    [api, setApi] = useState<AuthenticatedApi | null>(null),
    [owner, setOwner] = useState<string | null>(null),
    [services, setServices] = useState<DeveloperServices>(
      unavailableDeveloperServices,
    ),
    [revision, setRevision] = useState(0);
  const verifiedIdentity = useRef<string | null>(null);
  const recheck = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const session = currentVideoSessionSource(),
      baseUrl = process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
    if (!session || !baseUrl) {
      setState("unconfigured");
      return;
    }
    let live = true,
      generation = 0,
      checking = false,
      identity: string | null = verifiedIdentity.current;
    let client: AuthenticatedApi;
    try {
      client = createVideoApiClient({
        baseUrl,
        session,
        onAuthorizationFailure: (status) => {
          if (live) {
            setState(status);
            if (status === "unauthenticated" || status === "forbidden") {
              identity = null;
              verifiedIdentity.current = null;
              setOwner(null);
            }
          }
        },
      });
    } catch {
      setState("unconfigured");
      return;
    }
    setApi(client);
    async function check() {
      if (checking) return;
      checking = true;
      const ticket = ++generation;
      try {
        const result = await checkDeveloper(client);
        if (live && ticket === generation) {
          if (result.state === "ready") {
            identity = result.owner;
            verifiedIdentity.current = result.owner;
            setOwner(result.owner);
            setServices(result.services);
          } else if (
            result.state === "unauthenticated" ||
            result.state === "forbidden"
          ) {
            identity = null;
            verifiedIdentity.current = null;
            setOwner(null);
          }
          setState(result.state);
        }
      } catch {
        if (live && ticket === generation) setState("unavailable");
      } finally {
        checking = false;
      }
    }
    setState("checking");
    void check();
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void check();
      }
    };
    const subscription = authClient()?.auth.onAuthStateChange(
      (event, nextSession) => {
        if (event === "INITIAL_SESSION") return;
        // Do not await Supabase methods in its auth callback (refresh can deadlock).
        generation++;
        // Session identity can only invalidate the current view; it never grants access.
        // Supabase may re-emit SIGNED_IN for the same user on tab focus/refresh.
        if (
          event === "SIGNED_OUT" ||
          !identity ||
          nextSession?.user.id !== identity
        ) {
          identity = null;
          verifiedIdentity.current = null;
          setOwner(null);
          setState("checking");
        }
        setTimeout(() => {
          if (live) {
            checking = false;
            void check();
          }
        }, 0);
      },
    ).data.subscription;
    window.addEventListener("pageshow", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, 60000);
    return () => {
      live = false;
      generation++;
      subscription?.unsubscribe();
      clearInterval(timer);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, revision]);
  return {
    state: enabled ? state : ("disabled" as const),
    api,
    owner,
    services,
    recheck,
  };
}
