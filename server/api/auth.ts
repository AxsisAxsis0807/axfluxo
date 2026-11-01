import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { ownerSchema } from "../contracts/video";
import { ApiError } from "./errors";
export type Identity = { ownerId: string };
export type VerifyToken = (authorization: string | null) => Promise<Identity>;
export function jwtVerifier(
  keys: JWTVerifyGetKey,
  config: { issuer: string; audience: string; now?: () => Date },
): VerifyToken {
  return async (authorization) => {
    if (
      !authorization ||
      !/^Bearer [A-Za-z0-9._-]+$/i.test(authorization) ||
      authorization.length > 16384
    )
      throw new ApiError(401, "AUTH_REQUIRED");
    try {
      const { payload } = await jwtVerify(authorization.slice(7), keys, {
        algorithms: ["ES256", "RS256"],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ["sub", "exp", "iat"],
        currentDate: config.now?.(),
        clockTolerance: 0,
      });
      if (
        payload.role !== "authenticated" ||
        typeof payload.iat !== "number" ||
        payload.iat > (config.now?.() ?? new Date()).getTime() / 1000
      )
        throw new ApiError(401, "AUTH_REQUIRED");
      return { ownerId: ownerSchema.parse(payload.sub) };
    } catch (error) {
      if (error instanceof errors.JWTExpired)
        throw new ApiError(401, "AUTH_EXPIRED");
      throw new ApiError(401, "AUTH_REQUIRED");
    }
  };
}
export function supabaseVerifier(
  issuer: string,
  audience: string,
): VerifyToken {
  const url = new URL(issuer);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    issuer.endsWith("/")
  )
    throw new Error("Invalid JWT issuer configuration");
  return jwtVerifier(
    createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
    }),
    { issuer, audience },
  );
}
