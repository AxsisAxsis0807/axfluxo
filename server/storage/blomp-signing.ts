import { matchesBlompFileKey } from "./blomp-keys";
import { storageRoles } from "../../src/domain/storage/destinations";
import { z } from "zod";
import type { VerifyToken } from "../api/auth";
import { ApiError } from "../api/errors";
import type { BlompRef, BlompStorage } from "./blomp";

/** Local policy prototype only; NOT registered in the existing API.
 * Catalog must be server-owned and enforce membership/RLS on every call.
 * Writes remain unavailable until capacity, CORS and integrity contracts are verified.
 */
export function blompReadSigner(config: {
  verify: VerifyToken;
  catalog: (
    owner: string,
    fileId: string,
  ) => Promise<{
    owner: string;
    ref: BlompRef;
    size: number;
    verified: boolean;
    readable: boolean;
  } | null>;
  storage: Pick<BlompStorage, "sign">;
  enabled: () => boolean;
  now?: () => number;
}) {
  const recent = new Map<string, number[]>();
  return async (authorization: string | null, input: unknown) => {
    if (!config.enabled()) throw new ApiError(503, "STORAGE_DISABLED");
    const { ownerId } = await config.verify(authorization);
    const { fileId } = z.strictObject({ fileId: z.uuid() }).parse(input);
    const now = config.now?.() ?? Date.now();
    for (const [owner, times] of recent)
      if (times.every((t) => now - t >= 60000)) recent.delete(owner);
    if (!recent.has(ownerId) && recent.size >= 1000)
      throw new ApiError(429, "RATE_LIMITED");
    const times = (recent.get(ownerId) ?? []).filter((t) => now - t < 60000);
    if (times.length >= 10) throw new ApiError(429, "RATE_LIMITED");
    recent.set(ownerId, [...times, now]);
    const check = async () => {
      const file = await config.catalog(ownerId, fileId);
      if (
        !file ||
        file.owner !== ownerId ||
        !storageRoles.some((role) =>
          matchesBlompFileKey(file.ref.key, role, ownerId),
        ) ||
        !file.verified ||
        !file.readable ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0
      )
        throw new ApiError(403, "FILE_ACCESS_DENIED");
      return file;
    };
    const file = await check();
    const identity = JSON.stringify(file);
    const signed = await config.storage.sign(file.ref, "GET");
    const latestIdentity = await config.verify(authorization);
    if (latestIdentity.ownerId !== ownerId)
      throw new ApiError(403, "FILE_ACCESS_DENIED");
    const latest = await check();
    if (!config.enabled() || JSON.stringify(latest) !== identity)
      throw new ApiError(403, "FILE_ACCESS_DENIED");
    return signed; // Caller must use no-store and must never log/persist this bearer capability.
  };
}
