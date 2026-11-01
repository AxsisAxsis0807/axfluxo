import { Pool, type PoolConfig } from "pg";
import type { Database } from "./database";
/** A dedicated non-superuser login inherits axfluxo_video_api. No service-role/browser key. */
export function postgresDatabase(
  config: PoolConfig,
  role: "axfluxo_video_api" | "axfluxo_video_probe" = "axfluxo_video_api",
): Database & { close(): Promise<void> } {
  const pool = new Pool({
    ...config,
    max: 10,
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
        await client.query(
          role === "axfluxo_video_probe"
            ? "SET LOCAL ROLE axfluxo_video_probe"
            : "SET LOCAL ROLE axfluxo_video_api",
        );
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
