// Applies the checked-in SQL migrations once, in order, and records what it ran.
// Never runs at service startup. Inside a deployed app:
//   blitz run <app> -- node /app/migrate.mjs
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { databaseUrl } from "../runtime/config";
import { databaseTls } from "./tls";
import { isEntrypoint } from "../runtime/lifecycle";

type Queryable = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rowCount: number | null; rows: unknown[] }>;
};

const TRACKING_TABLE = "public.axfluxo_schema_migrations";
/** Roles the API and the export worker switch to; the login must hold them all. */
const REQUIRED_ROLES = [
  "axfluxo_video_api",
  "axfluxo_export_api",
  "axfluxo_export_worker",
];

export async function migrationFiles(directory: string) {
  const names = await readdir(directory);
  return names.filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
}

export async function applyMigrations(
  db: Queryable,
  directory: string,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  let applied = 0;
  for (const name of await migrationFiles(directory)) {
    const done = await db.query(
      `SELECT 1 FROM ${TRACKING_TABLE} WHERE name = $1`,
      [name],
    );
    if (done.rowCount) {
      log(`skip ${name}`);
      continue;
    }
    await db.query(await readFile(join(directory, name), "utf8"));
    await db.query(`INSERT INTO ${TRACKING_TABLE} (name) VALUES ($1)`, [name]);
    log(`applied ${name}`);
    applied += 1;
  }
  return applied;
}

/** Blitz injects one login for API and worker, so it needs both service roles. */
async function grantServiceRoles(db: Queryable, log: (line: string) => void) {
  for (const role of REQUIRED_ROLES) {
    await db.query(`GRANT ${role} TO current_user`);
    log(`granted ${role}`);
  }
}

export async function main(env: Record<string, string | undefined> = process.env) {
  const directory =
    env.AXFLUXO_MIGRATIONS_DIR ?? join(process.cwd(), "migrations");
  const client = new Client({
    connectionString: databaseUrl(env),
    ssl: databaseTls(env).ssl,
  });
  await client.connect();
  try {
    const who = await client.query(
      "SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user",
    );
    const row = who.rows[0] as
      | { rolsuper?: boolean; rolcreaterole?: boolean }
      | undefined;
    if (!row?.rolsuper && !row?.rolcreaterole)
      process.stderr.write(
        "Warning: this login cannot create roles; migrations 001 and 008 need CREATEROLE.\n",
      );
    const count = await applyMigrations(client as unknown as Queryable, directory);
    await grantServiceRoles(client as unknown as Queryable, (line) =>
      process.stdout.write(`${line}\n`),
    );
    process.stdout.write(
      `Migrations up to date (${count} applied, ${count === 0 ? "nothing" : "then"} granted service roles).\n`,
    );
  } finally {
    await client.end();
  }
}

if (isEntrypoint(import.meta.url, ["migrate.mjs", "db/migrate.ts"])) {
  main().catch((error: unknown) => {
    const code =
      typeof error === "object" && error && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    const message = error instanceof Error ? error.message : "";
    process.stderr.write(
      `Migration failed${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}\n`,
    );
    process.exitCode = 1;
  });
}
