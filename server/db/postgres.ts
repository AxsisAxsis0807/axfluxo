import { Pool, type PoolConfig } from "pg";
import type { Database } from "./database";
/** A dedicated non-superuser login inherits axfluxo_video_api. No service-role/browser key. */
export function postgresDatabase(
  config: PoolConfig,
  role:
    | "axfluxo_video_api"
    | "axfluxo_video_probe"
    | "axfluxo_video_delete"
    | "axfluxo_video_notify"
    | "axfluxo_video_render"
    | "axfluxo_export_worker"
    | "axfluxo_export_api" = "axfluxo_video_api",
): Database & { close(): Promise<void> } {
  if (
    ![
      "axfluxo_video_api",
      "axfluxo_video_probe",
      "axfluxo_video_render",
      "axfluxo_video_delete",
      "axfluxo_video_notify",
      "axfluxo_export_worker",
      "axfluxo_export_api",
    ].includes(role)
  )
    throw Error("Invalid role");
  const max = config.max ?? (role === "axfluxo_video_api" ? 2 : 1);
  if (!Number.isInteger(max) || max < 1 || max > 10)
    throw Error("Invalid database pool maximum");
  const pool = new Pool({
    ...config,
    max,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    idle_in_transaction_session_timeout: 10000,
  });
  pool.on("error", () => {
    /* Never log connection strings or driver errors. Operations fail closed. */
  });
  return {
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        const result = await work({
          query: (text, values) => client.query(text, values),
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
