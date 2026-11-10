// Optional local CLI. The authenticated UI uses the same guarded setup.
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { setup } from "./lifecycle.mjs";
import { configuration, validateDatabase } from "./core.mjs";
const action = process.argv[2];
if (!["--setup", "--drop-probe-schema"].includes(action))
  throw Error("Explicit probe-only admin action required");
let db;
try {
  const config = configuration(process.env);
  db = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
    ssl: config.dbTls ? { rejectUnauthorized: true } : false,
  });
  await validateDatabase(db, config);
  if (action === "--setup") await setup(db, config);
  else {
    // The cleanup SQL independently checks the explicitly confirmed name.
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('probe.expected_database',$1,true)",
        [config.expectedDatabase],
      );
      await client.query(
        await readFile(new URL("./cleanup.sql", import.meta.url), "utf8"),
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  console.log(
    action === "--setup"
      ? "Probe-only schema created. Disable the one-shot setup step now."
      : "Only axfluxo_connection_probe schema removed.",
  );
} catch {
  console.error(
    "Probe-only database setup/cleanup refused. Check dedicated DB name, schema state, permissions and TLS.",
  );
  process.exitCode = 1;
} finally {
  await db?.end();
}
