import { describe, expect, it } from "vitest";
import { startApi } from "../api/main";
import {
  StartupError,
  safeStartupDetail,
  startupFailureLine,
} from "../api/startup";
import { ConfigurationError } from "../runtime/config";

const base = {
  VIDEO_JWT_ISSUER: "https://example.supabase.co/auth/v1",
  VIDEO_JWT_AUDIENCE: "authenticated",
  DATABASE_URL: "postgres://user:top-secret-password@127.0.0.1:1/video",
  VIDEO_ALLOWED_ORIGINS: "https://example.github.io",
};

async function failure(env: Record<string, string | undefined>) {
  try {
    await startApi(env);
    throw new Error("startup must fail for this test");
  } catch (error) {
    if (!(error instanceof StartupError)) throw error;
    return error;
  }
}

describe("startup diagnostics", () => {
  it("names the phase and reason for a CORS shape error without leaking values", async () => {
    const error = await failure({
      ...base,
      VIDEO_ALLOWED_ORIGINS: "https://example.github.io/axfluxo",
    });
    expect(error.stage).toBe("router");
    const line = startupFailureLine(error);
    expect(line).toBe(
      "API startup failed at router: Invalid CORS origin configuration",
    );
    expect(line).not.toContain("top-secret-password");
    expect(line).not.toContain("postgres://");
  });

  it("reports missing JWT settings at the config phase by setting name", async () => {
    const error = await failure({ ...base, VIDEO_JWT_AUDIENCE: undefined });
    expect(error.stage).toBe("config");
    expect(startupFailureLine(error)).toBe(
      "API startup failed at config: Missing VIDEO_JWT_ISSUER/VIDEO_JWT_AUDIENCE configuration",
    );
  });

  it("reports a malformed export setting by name", async () => {
    const error = await failure({
      ...base,
      EXPORT_ENABLED: "true",
      EXPORT_MAX_UPLOAD_BYTES: "not-a-number",
    });
    expect(error.stage).toBe("export");
    expect(startupFailureLine(error)).toContain(
      "Invalid EXPORT_MAX_UPLOAD_BYTES configuration",
    );
  });

  it("keeps system error codes but drops unknown messages", () => {
    expect(
      startupFailureLine(new StartupError("listen", { code: "EADDRINUSE" })),
    ).toBe("API startup failed at listen: EADDRINUSE");
    expect(
      startupFailureLine(
        new StartupError("router", new Error("connect postgres://a:b@h/db")),
      ),
    ).toBe("API startup failed at router");
    expect(
      safeStartupDetail(new Error("token=abc123 rejected by upstream")),
    ).toBeNull();
  });

  it("still surfaces configuration errors outside startup", () => {
    expect(
      startupFailureLine(
        new ConfigurationError("Invalid VIDEO_DATABASE_TLS configuration"),
      ),
    ).toBe(
      "API startup failed: Invalid VIDEO_DATABASE_TLS configuration",
    );
  });
});
