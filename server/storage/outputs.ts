import { r2Storage } from "./r2";
import type { MultipartStorage } from "./multipart";
/** Physically separate bucket. Legacy/original reads never route by a client-supplied key. */
export function outputStorage(
  env: Record<string, string | undefined>,
  original: MultipartStorage | null,
) {
  const fields = [
    "VIDEO_OUTPUT_ENDPOINT",
    "VIDEO_OUTPUT_BUCKET",
    "VIDEO_OUTPUT_ACCESS_KEY_ID",
    "VIDEO_OUTPUT_SECRET_ACCESS_KEY",
  ].map((k) => env[k]);
  if (!fields.some(Boolean)) return original;
  if (!fields.every(Boolean) || !original || fields[1] === env.CLOUD_R2_BUCKET)
    throw Error("Separate output bucket required");
  const outputs = r2Storage({
    endpoint: fields[0]!,
    bucket: fields[1]!,
    accessKeyId: fields[2]!,
    secretAccessKey: fields[3]!,
  });
  return {
    ...original,
    renderNamespace: "outputs-v1",
    putRender: outputs.putRender,
    forRenderObject: (namespace: string) =>
      namespace === "outputs-v1"
        ? outputs
        : namespace === "legacy"
          ? original
          : (() => {
              throw Error("Unknown storage namespace");
            })(),
  } satisfies MultipartStorage;
}
