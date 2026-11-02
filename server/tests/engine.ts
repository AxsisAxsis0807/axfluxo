import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { postgresDatabase } from "../db/postgres";
import type { Database, Sql } from "../db/database";
export interface TestEngine extends Sql {
  asRole(
    role:
      | "axfluxo_video_api"
      | "axfluxo_video_probe"
      | "axfluxo_video_render"
      | "axfluxo_video_delete"
      | "axfluxo_video_notify",
  ): Database;
  exec(text: string): Promise<unknown>;
  transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
/** Optional native multi-connection run. Refuse every non-loopback/non-test database. */
export function testEngine(directory: string): TestEngine {
  const connectionString = process.env.AXFLUXO_TEST_POSTGRES_URL;
  if (!connectionString) {
    const db = new PGlite(directory);
    return {
      query: (text, values) => db.query(text, values),
      exec: (text) => db.exec(text),
      transaction: (work) =>
        db.transaction((tx) =>
          work({ query: (text, values) => tx.query(text, values) }),
        ),
      asRole: (role) => ({
        transaction: (work) =>
          db.transaction(async (tx) => {
            await tx.query(`SET LOCAL ROLE ${role}`);
            return work({ query: (text, values) => tx.query(text, values) });
          }),
      }),
      close: () => db.close(),
    };
  }
  const url = new URL(connectionString);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.pathname.startsWith("/axfluxo_video_test") ||
    url.search ||
    url.hash
  )
    throw new Error("Only a dedicated loopback test database is allowed");
  const pool = new Pool({ connectionString, max: 8 });
  const runtime = postgresDatabase({ connectionString });
  const probe = postgresDatabase({ connectionString }, "axfluxo_video_probe");
  const render = postgresDatabase({ connectionString }, "axfluxo_video_render");
  const deletion = postgresDatabase(
      { connectionString },
      "axfluxo_video_delete",
    ),
    notify = postgresDatabase({ connectionString }, "axfluxo_video_notify");
  return {
    asRole: (role) =>
      role === "axfluxo_video_delete"
        ? deletion
        : role === "axfluxo_video_notify"
          ? notify
          : role === "axfluxo_video_render"
            ? render
            : role === "axfluxo_video_probe"
              ? probe
              : runtime,
    query: (text, values) => pool.query(text, values),
    exec: (text) => pool.query(text),
    transaction: (work) => runtime.transaction(work),
    close: async () => {
      await deletion.close();
      await notify.close();
      await runtime.close();
      await probe.close();
      await render.close();
      await pool.end();
    },
  };
}
