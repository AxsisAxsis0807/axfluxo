import { ApiError } from "../api/errors";
import { secret, sha256 } from "../google-drive/security";
import type { DriveCloud, Inventory } from "./service";
import { driveRenderStorage, writeDriveObject } from "./storage";
export function drivePreviewStorage(
  service: DriveCloud,
  owner: string,
  version: string,
) {
  const reader = driveRenderStorage(service, owner, "", null);
  return {
    async head(key: string) {
      const row = await service.owner(
        owner,
        async (sql) =>
          (
            await sql.query(
              "SELECT state FROM axfluxo_video.drive_inventory WHERE owner_id=$1 AND object_key=$2",
              [owner, key],
            )
          ).rows[0],
      );
      if (row && row.state !== "ready") return null;
      return reader.head(key);
    },
    stream: reader.stream,
    quotaManaged: true,
    resources: {
      directory: service.policy.directory,
      maxBytes: service.policy.maxWorkBytes,
      minFreeBytes: service.policy.minFreeBytes,
    },
    async putDerived(
      key: string,
      path: string,
      size: number,
      mime: string,
      hash: string,
      signal?: AbortSignal,
    ) {
      if (!key.startsWith(`derivatives/${owner}/${version}/`))
        throw new ApiError(403, "DRIVE_IDENTITY_MISMATCH");
      const row = await service.reserve(owner, {
        key,
        objectKey: key,
        size,
        hash,
        mime,
        name: key.split("/").at(-1)!,
        namespace: "preview",
      });
      await writeDriveObject(service, owner, row, path, signal);
    },
    async access(key: string) {
      const row = await service.owner(
        owner,
        async (sql) =>
          (
            await sql.query<Inventory>(
              "SELECT * FROM axfluxo_video.drive_inventory WHERE owner_id=$1 AND object_key=$2 AND state='ready'",
              [owner, key],
            )
          ).rows[0],
      );
      if (!row) throw new ApiError(404, "NOT_FOUND");
      const token = secret();
      await service.owner(owner, (sql) =>
        sql.query(
          "INSERT INTO axfluxo_video.drive_media_tickets(token_hash,owner_id,object_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
          [sha256(token), owner, row.id],
        ),
      );
      return {
        url: new URL("/v1/drive/media/" + token, service.google.config.callback)
          .href,
        expiresAt: Date.now() + 600000,
      };
    },
  };
}
