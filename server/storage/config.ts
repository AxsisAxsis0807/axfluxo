import { outputStorage } from "./outputs";
import { r2Storage } from "./r2";
export function cloudConfiguration(env: Record<string, string | undefined>) {
  const fields = [
    env.CLOUD_R2_ENDPOINT,
    env.CLOUD_R2_BUCKET,
    env.CLOUD_R2_ACCESS_KEY_ID,
    env.CLOUD_R2_SECRET_ACCESS_KEY,
  ];
  if (fields.some(Boolean) && !fields.every(Boolean))
    throw new Error("Incomplete server storage configuration");
  const original = fields.every(Boolean)
    ? r2Storage({
        endpoint: fields[0]!,
        bucket: fields[1]!,
        accessKeyId: fields[2]!,
        secretAccessKey: fields[3]!,
      })
    : null;
  return {
    storage: outputStorage(env, original),
    previewUnitsPerSecond: env.CLOUD_PREVIEW_UNITS_PER_SECOND
      ? Number(env.CLOUD_PREVIEW_UNITS_PER_SECOND)
      : undefined,
    previewEnabled: () =>
      Boolean(original) && env.CLOUD_PREVIEW_ENABLED === "true",
    uploadsEnabled: () =>
      Boolean(original) && env.CLOUD_UPLOADS_ENABLED === "true",
  };
}
