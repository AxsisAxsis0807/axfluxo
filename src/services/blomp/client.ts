import { isSourceRole } from "../../domain/storage/destinations";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import {
  blompAccess,
  blompFile,
  blompOverview,
  blompParts,
  blompPartSize,
  blompStart,
  partLength,
  type BlompStart,
  type BlompFile,
} from "../../domain/blomp/storage";
import {
  createVideoApiClient,
  currentVideoSessionSource,
} from "../video/api-client";
import { value, UploadError } from "../cloud-library/upload";

const root = "/storage/blomp";
export function blompApiOrigin() {
  try {
    return process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
  } catch {
    // Standalone browser bundles may have no process shim.
    return undefined;
  }
}

export function currentBlompClient() {
  try {
    const baseUrl = blompApiOrigin();
    const session = baseUrl ? currentVideoSessionSource() : null;
    if (!baseUrl || !session) return null;
    return blompClient(
      createVideoApiClient({
        baseUrl,
        session,
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(90000) }),
      }),
    );
  } catch {
    return null;
  }
}

export function blompClient(api: ReturnType<typeof createVideoApiClient>) {
  const path = (id: string, action?: string) =>
    `${root}/files/${encodeURIComponent(id)}${action ? "/" + action : ""}`;
  const post = <T>(
    url: string,
    schema: z.ZodType<T>,
    body: unknown,
    key = crypto.randomUUID(),
  ) => api.request(url, schema, "POST", body, key);
  return {
    overview: () => api.request(root + "/overview", blompOverview),
    list: (cursor?: string) =>
      api.request(
        root +
          "/files" +
          (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        z.strictObject({
          files: z.array(blompFile),
          cursor: z.uuid().nullable(),
        }),
      ),
    file: (id: string) => api.request(path(id), blompFile),
    start: (input: BlompStart, key: ReturnType<typeof crypto.randomUUID>) =>
      post(root + "/files", blompFile, input, key),
    resume: (id: string) =>
      post(
        path(id, "resume"),
        z.strictObject({ file: blompFile, parts: blompParts }),
        {},
      ),
    sign: (id: string, number: number) =>
      post(path(id, "part"), blompAccess, { number }),
    complete: (id: string) => post(path(id, "complete"), blompFile, {}),
    pause: (id: string) => post(path(id, "pause"), blompFile, {}),
    cancel: (id: string) => post(path(id, "cancel"), blompFile, {}),
    download: (id: string) => post(path(id, "download"), blompAccess, {}),
  };
}
export type BlompClient = ReturnType<typeof blompClient>;

export function checkedBlompUrl(value: string) {
  const url = new URL(value);
  if (
    url.origin !== "https://storage.blomp.com" ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new UploadError("INVALID_RESPONSE");
  return url.href;
}
export async function blompDigest(blob: Blob, signal: AbortSignal) {
  const hash = sha256.create();
  const chunkSize = 1024 ** 2;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    signal.throwIfAborted();
    hash.update(
      new Uint8Array(
        await blob.slice(offset, offset + chunkSize).arrayBuffer(),
      ),
    );
  }
  signal.throwIfAborted();
  return bytesToHex(hash.digest());
}

async function sendPart(
  url: string,
  blob: Blob,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  const response = await fetch(checkedBlompUrl(url), {
    method: "PUT",
    body: blob,
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
  }).catch(() => {
    throw new UploadError("UPLOAD_INTERRUPTED");
  });
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new UploadError("UPLOAD_INTERRUPTED");
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    throw new UploadError("UPLOAD_PART_UNCONFIRMED");
  }
  // Browsers do not expose upload progress for fetch with redirects disabled.
  progress(blob.size);
}

let transferActive = false;
export async function uploadBlomp({
  api,
  blob,
  input,
  resumeId,
  signal,
  progress,
  transfer = sendPart,
}: {
  api: BlompClient;
  blob: Blob;
  input: Omit<BlompStart, "sha256" | "size">;
  resumeId?: string;
  signal: AbortSignal;
  progress: (bytes: number) => void;
  transfer?: typeof sendPart;
}) {
  if (transferActive) throw new UploadError("UPLOAD_BUSY");
  transferActive = true;
  let activeId: string | undefined;
  try {
    const metadata = blompStart.parse({
      ...input,
      size: blob.size,
      sha256: "0".repeat(64),
    });
    metadata.sha256 = await blompDigest(blob, signal);
    signal.throwIfAborted();
    const file = resumeId
      ? value(await api.file(resumeId))
      : value(await api.start(metadata, crypto.randomUUID()));
    if (
      Object.entries(metadata).some(
        ([field, v]) => file[field as keyof typeof file] !== v,
      )
    )
      throw new UploadError("UPLOAD_FILE_MISMATCH");
    if (file.status === "ready") return file;
    if (file.status === "completing" || file.status === "verifying")
      return value(await api.complete(file.id));
    signal.throwIfAborted();
    const { parts } = value(await api.resume(file.id));
    activeId = file.id;
    const uploaded = new Set(parts.map((p) => p.number));
    let sent = 0;
    for (let offset = 0; offset < blob.size; offset += blompPartSize) {
      signal.throwIfAborted();
      const number = offset / blompPartSize + 1,
        length = partLength(blob.size, number);
      if (!uploaded.has(number)) {
        const part = blob.slice(offset, offset + length);
        for (let attempt = 0; ; attempt++) {
          const { url, expiresAt } = value(await api.sign(file.id, number));
          try {
            if (expiresAt <= Date.now())
              throw new UploadError("UPLOAD_SIGNATURE_EXPIRED");
            await transfer(url, part, signal, (bytes) =>
              progress(sent + bytes),
            );
            break;
          } catch (error) {
            signal.throwIfAborted();
            if (
              attempt ||
              !(error instanceof UploadError) ||
              error.code !== "UPLOAD_SIGNATURE_EXPIRED"
            )
              throw error;
          }
        }
      }
      sent += length;
      progress(sent);
    }
    signal.throwIfAborted();
    return value(await api.complete(file.id));
  } catch (error) {
    if (activeId) await api.pause(activeId).catch(() => undefined);
    throw error;
  } finally {
    transferActive = false;
  }
}

/** Bounded import into local tools. Larger source files use browser navigation. */
export async function importBlompSource(
  api: BlompClient,
  file: BlompFile,
  limit: number,
  transport = fetch,
) {
  if (!isSourceRole(file.role) || file.status !== "ready" || file.size > limit)
    throw new UploadError("INVALID_RESPONSE");
  return downloadVerifiedBlomp(api, file, limit, transport);
}

export async function downloadVerifiedBlomp(
  api: BlompClient,
  file: BlompFile,
  limit: number,
  transport = fetch,
  signal = AbortSignal.timeout(120000),
) {
  if (file.size > limit) throw new UploadError("INVALID_RESPONSE");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  await streamVerifiedBlomp(api, file, transport, signal, (chunk) => {
    chunks.push(new Uint8Array(chunk));
  });
  return new File(chunks, file.name, { type: file.mime });
}

async function streamVerifiedBlomp(
  api: BlompClient,
  file: BlompFile,
  transport: typeof fetch,
  signal: AbortSignal,
  write: (chunk: Uint8Array<ArrayBuffer>) => void | Promise<void>,
) {
  if (file.status !== "ready") throw new UploadError("INVALID_RESPONSE");
  signal.throwIfAborted();
  const access = value(await api.download(file.id));
  signal.throwIfAborted();
  const response = await transport(checkedBlompUrl(access.url), {
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    signal,
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new UploadError("REQUEST_FAILED");
  }
  const reader = response.body.getReader();
  const hash = sha256.create();
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > file.size) throw new UploadError("UPLOAD_FILE_MISMATCH");
      hash.update(value);
      await write(value);
    }
    signal.throwIfAborted();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (size !== file.size || bytesToHex(hash.digest()) !== file.sha256)
    throw new UploadError("UPLOAD_FILE_MISMATCH");
}

/** Stages verified output in origin-private storage, never a whole-file JS buffer. */
export async function stageVerifiedBlomp(
  api: BlompClient,
  file: BlompFile,
  signal: AbortSignal,
  storage = navigator.storage,
  transport = fetch,
) {
  signal.throwIfAborted();
  if (file.status !== "ready" || typeof storage?.getDirectory !== "function")
    throw new UploadError("BLOMP_DOWNLOAD_STORAGE_UNAVAILABLE");
  const estimate = await storage.estimate();
  if (
    estimate.quota === undefined ||
    estimate.usage === undefined ||
    estimate.quota - estimate.usage < file.size
  )
    throw new UploadError("BLOMP_DOWNLOAD_STORAGE_UNAVAILABLE");
  const directory = await (
    await storage.getDirectory()
  ).getDirectoryHandle("axfluxo-blomp-verified", { create: true });
  const name = crypto.randomUUID();
  const release = async () => {
    await directory.removeEntry(name).catch(() => undefined);
  };
  let writer: FileSystemWritableFileStream | undefined;
  try {
    signal.throwIfAborted();
    const handle = await directory.getFileHandle(name, { create: true });
    if (typeof handle.createWritable !== "function")
      throw new UploadError("BLOMP_DOWNLOAD_STORAGE_UNAVAILABLE");
    writer = await handle.createWritable();
    const output = writer;
    await streamVerifiedBlomp(api, file, transport, signal, (chunk) =>
      output.write(chunk),
    );
    await output.close();
    signal.throwIfAborted();
    const blob = await handle.getFile();
    if (blob.size !== file.size) throw new UploadError("UPLOAD_FILE_MISMATCH");
    return { blob, release };
  } catch (error) {
    await writer?.abort().catch(() => undefined);
    await release();
    throw error;
  }
}
