import { readFile } from "node:fs/promises";
import { validateDatabase, session } from "./core.mjs";
// One connection, transactional DDL and an advisory lock serialize initializers.
export async function setup(pool, config) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(71411010)");
    await validateDatabase(db, config);
    const exists = (
      await db.query(
        "SELECT 1 FROM pg_namespace WHERE nspname='axfluxo_connection_probe'",
      )
    ).rows.length;
    if (!exists) {
      const objects =
        await db.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%' LIMIT 1`);
      const schemas =
        await db.query(`SELECT 1 FROM pg_namespace WHERE nspname NOT IN
        ('public','pg_catalog','information_schema') AND nspname NOT LIKE 'pg_%' LIMIT 1`);
      if (objects.rows.length || schemas.rows.length)
        throw Error("DB_NOT_EMPTY");
      await db.query(
        await readFile(new URL("./setup.sql", import.meta.url), "utf8"),
      );
      await db.query(
        `INSERT INTO axfluxo_connection_probe.session(singleton,run_id) VALUES(true,$1)`,
        [config.run],
      );
    }
    const state = await session(db, config);
    await db.query("COMMIT");
    return state;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
