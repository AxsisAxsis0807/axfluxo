import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { databaseTls } from "../db/tls";
import { ConfigurationError } from "../runtime/config";

const certificate =
  "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";

describe("database TLS policy", () => {
  it("defaults to no TLS for the internal blitz.cloud database", () => {
    expect(databaseTls({})).toEqual({ ssl: undefined, mode: "disable" });
    expect(databaseTls({ VIDEO_DATABASE_TLS: "disable" })).toEqual({
      ssl: undefined,
      mode: "disable",
    });
  });

  it("encrypts without verification only when explicitly requested", () => {
    expect(databaseTls({ VIDEO_DATABASE_TLS: "require" })).toEqual({
      ssl: { rejectUnauthorized: false },
      mode: "require",
    });
  });

  it("verifies the chain and requires a CA for verify-full", () => {
    expect(() =>
      databaseTls({ VIDEO_DATABASE_TLS: "verify-full" }),
    ).toThrow(ConfigurationError);
    expect(
      databaseTls({
        VIDEO_DATABASE_TLS: "verify-full",
        VIDEO_DATABASE_CA: certificate,
      }),
    ).toEqual({
      ssl: { rejectUnauthorized: true, ca: certificate },
      mode: "verify-full",
    });
  });

  it("treats a CA alone as verify-full and reads a certificate file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "axfluxo-tls-"));
    try {
      const path = join(directory, "ca.pem");
      await writeFile(path, certificate, "utf8");
      expect(databaseTls({ VIDEO_DATABASE_CA: path })).toEqual({
        ssl: { rejectUnauthorized: true, ca: certificate },
        mode: "verify-full",
      });
      expect(() => databaseTls({ VIDEO_DATABASE_CA: join(directory, "x") })).toThrow(
        ConfigurationError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown modes and a CA that does not match the mode", () => {
    expect(() => databaseTls({ VIDEO_DATABASE_TLS: "prefer" })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      databaseTls({ VIDEO_DATABASE_TLS: "require", VIDEO_DATABASE_CA: certificate }),
    ).toThrow(ConfigurationError);
    expect(() =>
      databaseTls({ VIDEO_DATABASE_TLS: "disable", VIDEO_DATABASE_CA: certificate }),
    ).toThrow(ConfigurationError);
  });
});
