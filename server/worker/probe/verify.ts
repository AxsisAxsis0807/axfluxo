import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiError } from "../../api/errors";
import { scoped } from "../../api/assets/library";
import { UploadService, sessionRow } from "../../api/uploads/service";
import { probeMedia } from "./media";
export async function verifyUpload(
  service: UploadService,
  owner: string,
  id: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const claim = await service.claim(owner, id, ["verifying"]);
  if (!claim) return false;
  const dir = await mkdtemp(join(tmpdir(), "axfluxo-probe-")),
    path = join(dir, "source");
  try {
    const source = await service.storage.stream(claim.row.object_key, signal),
      hash = createHash("sha256");
    let bytes = 0,
      lastHeartbeat = Date.now();
    async function* checked() {
      for await (const chunk of source) {
        signal?.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > Number(claim!.row.size))
          throw new ApiError(422, "SIZE_MISMATCH");
        hash.update(chunk);
        if (Date.now() - lastHeartbeat > 30000) {
          await scoped(service.db, owner, async (sql) => {
            const r = await sessionRow(sql, owner, id);
            if (r.lease_token !== claim!.token)
              throw new ApiError(409, "UPLOAD_BUSY");
            await sql.query(
              "UPDATE axfluxo_video.upload_sessions SET lease_until=now()+interval '5 minutes' WHERE owner_id=$1 AND id=$2",
              [owner, id],
            );
          });
          lastHeartbeat = Date.now();
        }
        yield chunk;
      }
    }
    await pipeline(
      checked(),
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (bytes !== Number(claim.row.size))
      throw new ApiError(422, "SIZE_MISMATCH");
    const actual = hash.digest("hex");
    if (actual !== claim.row.expected_hash)
      throw new ApiError(422, "HASH_MISMATCH");
    const probe = await probeMedia(
      path,
      bytes,
      claim.row.declared_mime,
      signal,
    );
    await scoped(service.db, owner, async (sql) => {
      const row = await sessionRow(sql, owner, id);
      if (row.lease_token !== claim.token || row.state !== "verifying")
        throw new ApiError(409, "UPLOAD_BUSY");
      const existing = await sql.query(
        "SELECT id,asset_id FROM axfluxo_video.media_versions WHERE owner_id=$1 AND hash=$2",
        [owner, actual],
      );
      let assetId: string, versionId: string;
      if (existing.rows.length) {
        assetId = String(existing.rows[0].asset_id);
        versionId = String(existing.rows[0].id);
      } else {
        assetId = randomUUID();
        versionId = randomUUID();
        await sql.query(
          "INSERT INTO axfluxo_video.media_assets(id,owner_id,folder_id,name) VALUES($1,$2,$3,$4)",
          [assetId, owner, row.folder_id, row.name],
        );
        await sql.query(
          "INSERT INTO axfluxo_video.media_versions(id,owner_id,asset_id,object_key,hash,size,mime,kind,probe) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
          [
            versionId,
            owner,
            assetId,
            row.object_key,
            actual,
            bytes,
            probe.mime,
            probe.kind,
            JSON.stringify(probe),
          ],
        );
        await sql.query(
          "INSERT INTO axfluxo_video.resource_versions(owner_id,library_id,file_id,version_id,hash,kind) VALUES($1,'cloud',$2,$3,$4,$5)",
          [owner, assetId, versionId, actual, probe.kind],
        );
      }
      await sql.query(
        "UPDATE axfluxo_video.upload_sessions SET state='ready',asset_id=$3,version_id=$4,error_code=NULL,lease_token=NULL,lease_until=NULL WHERE owner_id=$1 AND id=$2",
        [owner, id, assetId, versionId],
      );
    });
    return true;
  } catch (error) {
    if (
      error instanceof ApiError &&
      [
        "HASH_MISMATCH",
        "SIZE_MISMATCH",
        "MIME_MISMATCH",
        "CORRUPT_MEDIA",
        "CODEC_UNSUPPORTED",
      ].includes(error.code)
    ) {
      await scoped(service.db, owner, async (sql) => {
        if (error.code === "SIZE_MISMATCH")
          await sql.query(
            "UPDATE axfluxo_video.media_quotas SET blocked=true WHERE owner_id=$1",
            [owner],
          );
        await sql.query(
          "UPDATE axfluxo_video.upload_sessions SET state='failed',error_code=$4,lease_token=NULL,lease_until=NULL WHERE owner_id=$1 AND id=$2 AND lease_token=$3",
          [owner, id, claim.token, error.code],
        );
      });
      return false;
    }
    await service.release(owner, id, claim.token).catch(() => undefined);
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
