// Explicit one-shot command. Never imported or run by the API/worker entrypoint.
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
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
  await validateDatabase(db);
  const sql = await readFile(
    new URL(
      action === "--setup" ? "./setup.sql" : "./cleanup.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await db.query(sql);
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
