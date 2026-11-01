import { createReadStream } from "node:fs";
import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  UploadPartCommand,
  ListPartsCommand,
  HeadObjectCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { MultipartStorage, StoredPart } from "./multipart";
/** No PutObject/DeleteObject/bucket-management capability is exposed. */
export function r2Storage(config: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): MultipartStorage {
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    !/^[a-z0-9]+\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error("Invalid R2 endpoint configuration");
  const client = new S3Client({
    endpoint: config.endpoint,
    region: "auto",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const bucket = config.bucket;
  const missing = (e: unknown) => {
    const name = (e as { name?: string }).name;
    return (
      name === "NotFound" || name === "NoSuchKey" || name === "NoSuchUpload"
    );
  };
  return {
    async putDerived(key, path, size, mime, sha256) {
      if (!key.startsWith("derivatives/"))
        throw new Error("Immutable original");
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(path),
          ContentLength: size,
          ContentType: mime,
          IfNoneMatch: "*",
          Metadata: { sha256 },
        }),
      );
    },
    async findUploads(key) {
      const ids: string[] = [];
      let KeyMarker: string | undefined, UploadIdMarker: string | undefined;
      do {
        const r = await client.send(
          new ListMultipartUploadsCommand({
            Bucket: bucket,
            Prefix: key,
            KeyMarker,
            UploadIdMarker,
          }),
        );
        for (const u of r.Uploads ?? [])
          if (u.Key === key && u.UploadId) ids.push(u.UploadId);
        KeyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
        UploadIdMarker = r.NextUploadIdMarker;
      } while (KeyMarker);
      return ids;
    },
    async create(key, owner, session) {
      const r = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: "application/octet-stream",
          Metadata: { owner, session },
        }),
      );
      if (!r.UploadId) throw new Error("Storage unavailable");
      return r.UploadId;
    },
    async signPart(key, id, number, md5) {
      const contentMD5 = Buffer.from(md5, "hex").toString("base64");
      const url = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: id,
          PartNumber: number,
          ContentMD5: contentMD5,
        }),
        { expiresIn: 300, signableHeaders: new Set(["content-md5"]) },
      );
      return {
        url,
        headers: { "Content-MD5": contentMD5 },
        expiresAt: Date.now() + 300000,
      };
    },
    async parts(key, id) {
      const result: StoredPart[] = [];
      let PartNumberMarker: string | undefined;
      do {
        const r = await client.send(
          new ListPartsCommand({
            Bucket: bucket,
            Key: key,
            UploadId: id,
            PartNumberMarker,
          }),
        );
        for (const p of r.Parts ?? [])
          if (p.PartNumber && p.ETag && p.Size !== undefined)
            result.push({ number: p.PartNumber, size: p.Size, etag: p.ETag });
        PartNumberMarker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
      } while (PartNumberMarker);
      return result;
    },
    async head(key) {
      try {
        const r = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return { size: r.ContentLength ?? -1 };
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    async complete(key, id, parts) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: id,
          MultipartUpload: {
            Parts: parts.map((p) => ({ PartNumber: p.number, ETag: p.etag })),
          },
        }),
      );
    },
    async abort(key, id) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: id,
          }),
        );
      } catch (e) {
        if (!missing(e)) throw e;
      }
    },
    async stream(key, signal) {
      const r = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: signal },
      );
      if (!r.Body || !(Symbol.asyncIterator in r.Body))
        throw new Error("Storage unavailable");
      return r.Body as AsyncIterable<Uint8Array>;
    },
    async access(key, mime, name) {
      const disposition = `attachment; filename="media"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`;
      return {
        url: await getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            ResponseContentType: mime,
            ResponseContentDisposition: disposition,
          }),
          { expiresIn: 60 },
        ),
        expiresAt: Date.now() + 60000,
      };
    },
  };
}
