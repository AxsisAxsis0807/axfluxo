import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { postgresDatabase } from "../db/postgres";
import type { Sql } from "../db/database";
export interface TestEngine extends Sql {
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
  return {
    query: (text, values) => pool.query(text, values),
    exec: (text) => pool.query(text),
    transaction: (work) => runtime.transaction(work),
    close: async () => {
      await runtime.close();
      await pool.end();
    },
  };
}
