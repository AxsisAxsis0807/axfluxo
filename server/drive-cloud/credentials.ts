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

type CachedAccess = {
  token: string;
  generation: string;
  expiresAt: number;
};
type RefreshInFlight = { generation: string; promise: Promise<string> };

// Keep short-lived access tokens in server memory only. Database keys isolate
// independent API/worker pools, while the SQL lease arbitrates between pools.
const accessCache = new WeakMap<Database, Map<string, CachedAccess>>();
const pendingRefresh = new WeakMap<Database, Map<string, RefreshInFlight>>();
function forDatabase<T>(
  store: WeakMap<Database, Map<string, T>>,
  db: Database,
): Map<string, T> {
  let values = store.get(db);
  if (!values) {
    values = new Map();
    store.set(db, values);
  }
  return values;
}

/** Shared by API and independent worker. No Google request is made inside a SQL transaction. */
/** Drop only the token that a Google 401 actually rejected. A delayed
 * response from an old request must never evict a freshly refreshed token. */
export function invalidateDriveAccess(
  db: Database,
  owner: string,
  rejectedToken: string,
): void {
  const cached = accessCache.get(db)?.get(owner);
  if (cached && cached.token === rejectedToken)
    accessCache.get(db)?.delete(owner);
}

export function driveCredentials(
  db: Database,
  google: GoogleDrive,
  owner: string,
) {
  return async () => {
    const tokens = forDatabase(accessCache, db);
    const running = forDatabase(pendingRefresh, db);
    // Read current generation on every operation so disconnect/reconnect
    // invalidates any cached access token even across requests.
    const state = await ownerTransaction(db, owner, async (sql) =>
      (
        await sql.query(
          "SELECT generation,connected,refresh_until>now() AS refreshing FROM axfluxo_video.drive_connections WHERE owner_id=$1",
          [owner],
        )
      ).rows[0],
    );
    if (!state?.connected) {
      tokens.delete(owner);
      throw new ApiError(401, "DRIVE_RECONNECT_REQUIRED");
    }
    const generation = String(state.generation);
    const cached = tokens.get(owner);
    if (
      cached?.generation === generation &&
      cached.expiresAt > Date.now() + 60_000
    )
      return cached.token;

    const inflight = running.get(owner);
    if (inflight?.generation === generation) return inflight.promise;
    if (state.refreshing) throw new ApiError(503, "DRIVE_REFRESH_BUSY");

    const work = (async () => {
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
        if (String(r.generation) !== generation)
          throw new ApiError(409, "DRIVE_CONNECTION_CHANGED");
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
        tokens.set(owner, {
          token: token.access_token,
          generation,
          expiresAt: Date.now() + token.expires_in * 1000,
        });
        return token.access_token;
      } catch (error) {
        tokens.delete(owner);
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
    })();
    running.set(owner, { generation, promise: work });
    try {
      return await work;
    } finally {
      if (running.get(owner)?.promise === work) running.delete(owner);
    }
  };
}
