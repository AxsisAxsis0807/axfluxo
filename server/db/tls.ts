import { readFileSync } from "node:fs";
import type { PoolConfig } from "pg";
import { ConfigurationError, type Environment } from "../runtime/config";

/**
 * Explicit database TLS policy. blitz.cloud PostgreSQL is reachable only from the
 * app's internal network and does not offer TLS, so the safe default is "disable".
 * Any database that terminates TLS must say so: "verify-full" validates the chain
 * (with VIDEO_DATABASE_CA when the issuer is private), "require" encrypts without
 * verification and is only for providers that cannot supply a CA.
 */
export type DatabaseTls = Exclude<PoolConfig["ssl"], undefined>;

const modes = ["disable", "require", "verify-full"] as const;
export type DatabaseTlsMode = (typeof modes)[number];

export function databaseTls(
  env: Environment,
): { ssl: DatabaseTls | undefined; mode: DatabaseTlsMode } {
  const rawMode = env.VIDEO_DATABASE_TLS;
  const ca = env.VIDEO_DATABASE_CA;
  const mode: DatabaseTlsMode =
    rawMode === undefined
      ? ca
        ? "verify-full"
        : "disable"
      : (rawMode as DatabaseTlsMode);
  if (!modes.includes(mode))
    throw new ConfigurationError("Invalid VIDEO_DATABASE_TLS configuration");
  if (mode === "disable") {
    if (ca)
      throw new ConfigurationError(
        "VIDEO_DATABASE_CA requires VIDEO_DATABASE_TLS=verify-full",
      );
    return { ssl: undefined, mode };
  }
  if (mode === "require") {
    if (ca)
      throw new ConfigurationError(
        "VIDEO_DATABASE_CA requires VIDEO_DATABASE_TLS=verify-full",
      );
    // Encrypted, not certificate-verified. Only for databases without a known CA.
    return { ssl: { rejectUnauthorized: false }, mode };
  }
  if (!ca)
    throw new ConfigurationError(
      "VIDEO_DATABASE_TLS=verify-full requires VIDEO_DATABASE_CA",
    );
  // A PEM bundle is accepted inline; otherwise the value is a readable path.
  const pem = ca.includes("BEGIN CERTIFICATE")
    ? ca
    : (() => {
        try {
          return readFileSync(ca, "utf8");
        } catch {
          throw new ConfigurationError(
            "VIDEO_DATABASE_CA is not a readable certificate",
          );
        }
      })();
  if (!pem.includes("BEGIN CERTIFICATE"))
    throw new ConfigurationError("VIDEO_DATABASE_CA is not a certificate");
  return { ssl: { rejectUnauthorized: true, ca: pem }, mode };
}

