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
