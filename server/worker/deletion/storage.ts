import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import type { OutputEraser } from "./service";
export function deletionStorage(
  env: Record<string, string | undefined>,
): OutputEraser {
  const bucket = env.VIDEO_DELETE_BUCKET,
    endpoint = env.VIDEO_OUTPUT_ENDPOINT;
  if (
    !bucket ||
    bucket !== env.VIDEO_OUTPUT_BUCKET ||
    !env.CLOUD_R2_BUCKET ||
    bucket === env.CLOUD_R2_BUCKET ||
    !env.VIDEO_DELETE_ACCESS_KEY_ID ||
    !env.VIDEO_DELETE_SECRET_ACCESS_KEY
  )
    throw Error("Dedicated output-only deletion credentials required");
  const u = new URL(endpoint ?? "");
  if (
    u.protocol !== "https:" ||
    !/^[a-z0-9]+\.r2\.cloudflarestorage\.com$/.test(u.hostname) ||
    u.pathname !== "/" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw Error("Invalid endpoint");
  const client = new S3Client({
    endpoint,
    region: "auto",
    credentials: {
      accessKeyId: env.VIDEO_DELETE_ACCESS_KEY_ID,
      secretAccessKey: env.VIDEO_DELETE_SECRET_ACCESS_KEY,
    },
  });
  return {
    async erase(key, size, hash) {
      if (
        !/^render-outputs\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.mp4$/.test(
          key,
        )
      )
        throw Error("Original/staging deletion forbidden");
      const missing = (e: unknown) =>
        (e as { $metadata?: { httpStatusCode?: number } })?.$metadata
          ?.httpStatusCode === 404;
      const abortSignal = AbortSignal.timeout(30 * 60 * 1000);
      let head;
      try {
        head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
          { abortSignal },
        );
      } catch (e) {
        if (missing(e)) return;
        throw e;
      }
      if (head.ContentLength !== size || !head.ETag)
        throw Error("Object changed");
      const data = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: head.ETag }),
        { abortSignal },
      );
      const h = createHash("sha256");
      let count = 0;
      for await (const part of data.Body as AsyncIterable<Uint8Array>) {
        count += part.byteLength;
        if (count > size) throw Error("Size mismatch");
        h.update(part);
      }
      if (count !== size || h.digest("hex") !== hash)
        throw Error("Hash mismatch");
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
            IfMatch: head.ETag,
          }),
          { abortSignal },
        );
      } catch (e) {
        if (!missing(e)) throw e;
      }
    },
  };
}
