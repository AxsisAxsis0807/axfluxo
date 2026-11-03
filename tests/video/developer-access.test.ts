import { it, expect, vi } from "vitest";
import { checkDeveloper } from "../../src/services/video/developer-access";
import { createVideoApiClient } from "../../src/services/video/api-client";
import { unavailableDeveloperServices } from "../../server/contracts/developer-services";
import { checkDeveloperApi } from "../../scripts/check-developer-api.mjs";
import { checkDeveloperConfig } from "../../scripts/check-developer-config.mjs";
const owner = "11111111-1111-4111-8111-111111111111";
const session = {
  async getSession() {
    return {
      data: {
        session: {
          access_token: "valid",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: owner },
        },
      },
      error: null,
    };
  },
  async refreshSession() {
    return { data: { session: null }, error: Error("expired") };
  },
};
it("never infers developer access from a browser owner or metadata", async () => {
  const onAuthorizationFailure = vi.fn(),
    fetcher = vi.fn(async () =>
      Response.json({ error: { code: "DEVELOPER_REQUIRED" } }, { status: 403 }),
    );
  const api = createVideoApiClient({
    baseUrl: "https://api.test",
    session,
    fetch: fetcher,
    onAuthorizationFailure,
  });
  expect((await checkDeveloper(api)).state).toBe("forbidden");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(onAuthorizationFailure).toHaveBeenCalledWith("forbidden");
});
it("an unavailable optional service catalogue allows only server-authorized editing UI", async () => {
  const api = createVideoApiClient({
    baseUrl: "https://api.test",
    session,
    fetch: async (url) =>
      String(url).endsWith("/me")
        ? Response.json({ ownerId: owner, membership: "developer" })
        : new Response("", { status: 404 }),
  });
  expect(await checkDeveloper(api)).toEqual({
    state: "ready",
    owner,
    services: unavailableDeveloperServices,
  });
});
it("revocation during service discovery overrides a previously successful me response", async () => {
  const api = createVideoApiClient({
    baseUrl: "https://api.test",
    session,
    fetch: async (url) =>
      String(url).endsWith("/me")
        ? Response.json({ ownerId: owner, membership: "developer" })
        : new Response("", { status: 403 }),
  });
  expect((await checkDeveloper(api)).state).toBe("forbidden");
});
it("fails builds closed for incomplete ON flags, without echoing credentials", () => {
  expect(() => checkDeveloperConfig({})).not.toThrow();
  expect(() =>
    checkDeveloperConfig({
      NEXT_PUBLIC_VIDEO_API_ORIGIN: "https://user:private@api.test",
    }),
  ).toThrow();
  expect(() =>
    checkDeveloperConfig({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "private-server-key",
    }),
  ).toThrow();
  expect(() =>
    checkDeveloperConfig({ NEXT_PUBLIC_ALL_VERSIONS_ENABLED: "true" }),
  ).toThrow();
  expect(() =>
    checkDeveloperConfig({ NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED: "true" }),
  ).toThrow();
  for (const origin of [
    "http://api.test",
    "https://user:secret@api.test",
    "https://api.test/path",
    "https://api.test/?token=secret",
  ])
    expect(() =>
      checkDeveloperConfig({
        NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED: "true",
        NEXT_PUBLIC_VIDEO_API_ORIGIN: origin,
      }),
    ).toThrow();
  expect(() =>
    checkDeveloperConfig({
      NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED: "true",
      NEXT_PUBLIC_ALL_VERSIONS_ENABLED: "true",
      NEXT_PUBLIC_VIDEO_API_ORIGIN: "https://api.test",
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        "sb_publishable_test_public_configuration",
    }),
  ).not.toThrow();
});

it("uses a real anonymous denial/CORS preflight before ON publication and skips network when OFF", async () => {
  const env = {
    NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED: "true",
    NEXT_PUBLIC_VIDEO_API_ORIGIN: "https://api.test",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      "sb_publishable_test_public_configuration",
  };
  const transport = vi.fn(
    async (_url: unknown, init?: RequestInit) =>
      new Response(null, {
        status: init?.method === "OPTIONS" ? 204 : 401,
        headers: {
          "access-control-allow-origin": "https://axsisaxsis0807.github.io",
          "access-control-allow-headers": "Authorization",
          "cache-control": "no-store",
        },
      }),
  );
  await checkDeveloperApi({}, transport);
  expect(transport).not.toHaveBeenCalled();
  await checkDeveloperApi(env, transport);
  expect(transport).toHaveBeenCalledTimes(3);
  await expect(
    checkDeveloperApi(env, async () => new Response(null, { status: 200 })),
  ).rejects.toThrow();
  await expect(
    checkDeveloperApi(env, async () => {
      throw Error("private connection detail");
    }),
  ).rejects.toThrow();
});
