import { describe, expect, it } from "vitest";
import { serverConfig } from "../api/config";
import { supabaseVerifier } from "../api/auth";
const env = {
  VIDEO_JWT_ISSUER: "https://example.supabase.co/auth/v1",
  VIDEO_JWT_AUDIENCE: "authenticated",
  VIDEO_DATABASE_URL: "postgres://user:private-password@localhost/video",
};
describe("server-only safe configuration", () => {
  it("defaults admission closed, budget unset and TLS on", () => {
    const config = serverConfig(env);
    expect(config.admissionEnabled()).toBe(false);
    expect(config.unitsPerFrame).toBeUndefined();
    expect(config.production).toBe(true);
  });
  it("never includes malformed database secrets in validation errors", () => {
    for (const connection of [
      "private-secret",
      "postgres://user:private-password@localhost/video?sslmode=no-verify",
    ]) {
      try {
        serverConfig({ ...env, VIDEO_DATABASE_URL: connection });
        throw new Error("test must reject invalid configuration");
      } catch (error) {
        expect(String(error)).toBe(
          "Error: Invalid database connection configuration",
        );
      }
    }
  });
  it("requires explicit issuer/audience and positive integer pricing", () => {
    expect(() =>
      serverConfig({ ...env, VIDEO_JWT_AUDIENCE: undefined }),
    ).toThrow();
    for (const price of ["", "0", "-1", "1.1", "Infinity", "1000001"])
      expect(() =>
        serverConfig({ ...env, VIDEO_UNITS_PER_FRAME: price }),
      ).toThrow();
    expect(() =>
      supabaseVerifier("http://example.supabase.co/auth/v1", "authenticated"),
    ).toThrow();
  });
});

it("prioritizes PORT and preserves VIDEO_API_PORT and explicit local bind", () => {
  expect(serverConfig(env).port).toBe(3100);
  expect(serverConfig(env).host).toBe("0.0.0.0");
  expect(serverConfig({ ...env, VIDEO_API_PORT: "3200" }).port).toBe(3200);
  expect(
    serverConfig({
      ...env,
      PORT: "3300",
      VIDEO_API_PORT: "3200",
      VIDEO_API_HOST: "127.0.0.1",
    }),
  ).toMatchObject({ port: 3300, host: "127.0.0.1" });
  for (const value of ["", " ", "0", "-1", "65536", "1.5", "Infinity", "1e3"])
    expect(() => serverConfig({ ...env, PORT: value })).toThrow();
});
it("uses DATABASE_URL fallback and rejects conflicting or unsafe connection values privately", () => {
  expect(
    serverConfig({
      ...env,
      VIDEO_DATABASE_URL: undefined,
      DATABASE_URL: env.VIDEO_DATABASE_URL,
    }).databaseUrl,
  ).toBe(env.VIDEO_DATABASE_URL);
  expect(() =>
    serverConfig({
      ...env,
      DATABASE_URL: env.VIDEO_DATABASE_URL.replace("postgres:", "postgresql:"),
    }),
  ).not.toThrow();
  for (const url of [
    "postgres://other:private-secret@localhost/video",
    "postgres://user:private-secret@localhost/video?sslmode=disable",
    "postgres:///video",
    "postgres://localhost/",
  ]) {
    try {
      serverConfig({ ...env, DATABASE_URL: url });
      expect.fail();
    } catch (e) {
      expect(String(e)).not.toMatch(
        /private-secret|private-password|postgres:\/\//,
      );
    }
  }
});
it("validates small finite pool settings", () => {
  expect(serverConfig(env).poolMax).toBe(2);
  for (const value of ["0", "11", "Infinity", "1.5"])
    expect(() => serverConfig({ ...env, VIDEO_API_POOL_MAX: value })).toThrow();
});

it("requires shutdown grace to exceed child termination grace", () => {
  expect(() => serverConfig({ ...env, VIDEO_SHUTDOWN_MS: "1000" })).toThrow();
  expect(serverConfig({ ...env, VIDEO_SHUTDOWN_MS: "3000" }).shutdownMs).toBe(
    3000,
  );
});
