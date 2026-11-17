import { createHash } from "node:crypto";

export const BLOMP_ENDPOINT = "https://storage.blomp.com";
export type BlompConfig = {
  endpoint: string;
  region: "us-east-1";
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};
/** Exact allowlist: never follow a caller-supplied host or region. */
export function blompConfiguration(
  env: Record<string, string | undefined>,
): BlompConfig | null {
  if (env.BLOMP_ENABLED === undefined || env.BLOMP_ENABLED === "false")
    return null;
  if (env.BLOMP_ENABLED !== "true") throw Error("Invalid Blomp configuration");
  const endpoint = env.BLOMP_ENDPOINT ?? BLOMP_ENDPOINT;
  const region = env.BLOMP_REGION ?? "us-east-1";
  const bucket = env.BLOMP_BUCKET ?? "";
  const accessKeyId = env.BLOMP_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.BLOMP_SECRET_ACCESS_KEY ?? "";
  // Account buckets may be email addresses. No paths, URL syntax or controls.
  if (
    endpoint !== BLOMP_ENDPOINT ||
    region !== "us-east-1" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.@_-]{0,253}$/.test(bucket) ||
    /[\x00-\x20\x7f]/.test(bucket) ||
    !accessKeyId.trim() ||
    !secretAccessKey.trim() ||
    /[\x00-\x20\x7f]/.test(accessKeyId + secretAccessKey)
  )
    throw Error("Invalid Blomp configuration");
  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

/** Persist with every future reference. A bucket change must never redirect old reads. */
export function blompLocation(config: BlompConfig): string {
  return (
    "blomp-v1:" +
    createHash("sha256")
      .update(JSON.stringify([config.endpoint, config.region, config.bucket]))
      .digest("hex")
  );
}
