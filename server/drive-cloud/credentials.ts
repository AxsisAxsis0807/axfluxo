import { randomUUID } from "node:crypto";
import type { Database, Sql } from "../db/database";
import { requireMembership } from "../api/jobs";
import { ApiError } from "../api/errors";
import type { GoogleDrive } from "../google-drive/google";
export const ownerTransaction = <T>(
  db: Database,
  owner: string,
  work: (sql: Sql) => Promise<T>,
) =>
  db.transaction(async (sql) => {
    await requireMembership(sql, owner);
    return work(sql);
  });
/** Shared by API and independent worker. No Google request is made inside a SQL transaction. */
export function driveCredentials(
  db: Database,
  google: GoogleDrive,
  owner: string,
) {
  return async () => {
    const lease = randomUUID();
    const row = await ownerTransaction(db, owner, async (sql) => {
      const r = (
        await sql.query(
          "SELECT *,refresh_until>now() AS refreshing FROM axfluxo_video.drive_connections WHERE owner_id=$1 FOR UPDATE",
          [owner],
        )
      ).rows[0];
      if (!r?.connected || !r.refresh_cipher)
        throw new ApiError(401, "DRIVE_RECONNECT_REQUIRED");
      if (r.refreshing) throw new ApiError(503, "DRIVE_REFRESH_BUSY");
      await sql.query(
        "UPDATE axfluxo_video.drive_connections SET refresh_lease=$2,refresh_until=now()+interval '15 seconds' WHERE owner_id=$1",
        [owner, lease],
      );
      return r;
    });
    try {
      const token = await google.token({
        grant_type: "refresh_token",
        refresh_token: google.config.vault.open(
          String(row.refresh_cipher),
          owner + ":refresh",
        ),
      });
      const saved = await ownerTransaction(db, owner, (sql) =>
        sql.query(
          "UPDATE axfluxo_video.drive_connections SET refresh_cipher=$4,refresh_lease=NULL,refresh_until=NULL WHERE owner_id=$1 AND generation=$2 AND refresh_lease=$3 AND connected RETURNING owner_id",
          [
            owner,
            row.generation,
            lease,
            token.refresh_token
              ? google.config.vault.seal(
                  token.refresh_token,
                  owner + ":refresh",
                )
              : row.refresh_cipher,
          ],
        ),
      );
      if (!saved.rows.length)
        throw new ApiError(409, "DRIVE_CONNECTION_CHANGED");
      return token.access_token;
    } catch (error) {
      await ownerTransaction(db, owner, (sql) =>
        sql.query(
          "UPDATE axfluxo_video.drive_connections SET refresh_lease=NULL,refresh_until=NULL,connected=CASE WHEN $4 THEN false ELSE connected END,refresh_cipher=CASE WHEN $4 THEN NULL ELSE refresh_cipher END WHERE owner_id=$1 AND generation=$2 AND refresh_lease=$3",
          [
            owner,
            row.generation,
            lease,
            error instanceof ApiError &&
              error.code === "DRIVE_RECONNECT_REQUIRED",
          ],
        ),
      ).catch(() => undefined);
      throw error;
    }
  };
}
