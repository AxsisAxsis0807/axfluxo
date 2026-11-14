import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
export const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export const challenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");
/** AES-256-GCM binds every ciphertext to its owner and purpose. Never browser code. */
export function tokenVault(encodedKey: string) {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey)
    throw Error("Invalid Google Drive encryption configuration");
  return {
    seal(value: string, context: string) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context));
      return [
        "v1",
        iv.toString("base64url"),
        Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString(
          "base64url",
        ),
        cipher.getAuthTag().toString("base64url"),
      ].join(".");
    },
    open(value: string, context: string) {
      const [version, iv, data, tag, ...extra] = value.split(".");
      if (version !== "v1" || !iv || !data || !tag || extra.length)
        throw Error("Invalid encrypted credential");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(iv, "base64url"),
      );
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        cipher.update(Buffer.from(data, "base64url")),
        cipher.final(),
      ]).toString("utf8");
    },
  };
}
export type DriveConfig = {
  clientId: string;
  clientSecret: string;
  callback: string;
  frontendUrl: string;
  vault: ReturnType<typeof tokenVault>;
};
export function driveConfiguration(
  env: Record<string, string | undefined>,
): DriveConfig | null {
  if (env.GOOGLE_DRIVE_ENABLED !== "true") return null;
  const {
    GOOGLE_DRIVE_CLIENT_ID: clientId,
    GOOGLE_DRIVE_CLIENT_SECRET: clientSecret,
    GOOGLE_DRIVE_PUBLIC_ORIGIN: origin,
    GOOGLE_DRIVE_TOKEN_KEY: key,
    GOOGLE_DRIVE_FRONTEND_URL: frontendUrl,
  } = env;
  if (!clientId || !clientSecret || !origin || !key || !frontendUrl)
    throw Error("Missing Google Drive configuration");
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username ||
    url.password
  )
    throw Error("Invalid Google Drive public origin");
  const frontend = new URL(frontendUrl);
  if (
    frontend.protocol !== "https:" ||
    frontend.username ||
    frontend.password ||
    frontend.search ||
    frontend.hash ||
    !frontend.pathname.endsWith("/developer/video/")
  )
    throw Error("Invalid Google Drive frontend URL");
  return {
    frontendUrl,
    clientId,
    clientSecret,
    callback: origin + "/api/integrations/google-drive/callback",
    vault: tokenVault(key),
  };
}
