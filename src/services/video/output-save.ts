/** Deliberately no saved state: only an explicit Photos attestation may create a deletion ticket. */
export const MAX_SHARE_BYTES = 32 * 1024 * 1024;
export async function prepareShare(
  url: string,
  size: number,
  filename: string,
  fetcher: typeof fetch = fetch,
) {
  if (size > MAX_SHARE_BYTES || size <= 0) throw Error("DIRECT_SAVE_REQUIRED");
  const response = await fetcher(url, {
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body) throw Error("DOWNLOAD_FAILED");
  const reader = response.body.getReader(),
    chunks: Uint8Array<ArrayBuffer>[] = [];
  let count = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > size || count > MAX_SHARE_BYTES) {
        await reader.cancel();
        throw Error("DIRECT_SAVE_REQUIRED");
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (count !== size) throw Error("DOWNLOAD_FAILED");
  return new File(chunks, filename.replace(/[\\/\u0000-\u001f]/g, "_"), {
    type: "video/mp4",
  });
}
export async function sharePrepared(file: File, share: typeof navigator.share) {
  try {
    await share({ files: [file] });
    return "shared" as const;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      return "cancelled" as const;
    throw Error("SHARE_FAILED");
  }
}

export function validOutputAccess(
  signed: { url: string; expiresAt: number; hash: string; size: number },
  item: { hash: string; size: number },
  now = Date.now(),
) {
  const u = new URL(signed.url);
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    signed.expiresAt > now &&
    signed.hash === item.hash &&
    signed.size === item.size
  );
}
