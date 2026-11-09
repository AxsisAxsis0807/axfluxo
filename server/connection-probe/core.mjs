import {
  createHash,
  createHmac,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open } from "node:fs/promises";
import { isAbsolute, join, parse } from "node:path";
export const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const digest = (data) => createHash("sha256").update(data).digest("hex");
export function equal(a, b) {
  const x = Buffer.from(a ?? ""),
    y = Buffer.from(b ?? "");
  return x.length === y.length && timingSafeEqual(x, y);
}
export function configuration(env) {
  const role = env.PROBE_ROLE;
  if (!["api", "worker"].includes(role) || !uuid.test(env.PROBE_RUN_ID ?? ""))
    throw Error("Invalid probe role/run ID");
  const expires = Date.parse(env.PROBE_EXPIRES_AT ?? "");
  if (!Number.isFinite(expires) || expires > Date.now() + 1800000)
    throw Error("Set an absolute expiry no more than 30 minutes ahead");
  if (
    (env.PROBE_TOKEN ?? "").length < 32 ||
    (env.PROBE_INTERNAL_KEY ?? "").length < 32
  )
    throw Error("Private probe credentials required");
  const root = env.PROBE_ROOT ?? "/probe-data";
  if (!isAbsolute(root) || root === "/" || root.includes(".."))
    throw Error("Dedicated probe root required");
  const db = new URL(env.PROBE_DATABASE_URL ?? env.DATABASE_URL ?? "");
  if (
    !["postgres:", "postgresql:"].includes(db.protocol) ||
    !/^axfluxo[-_]probe[-_][a-z0-9_-]+$/.test(
      decodeURIComponent(db.pathname.slice(1)),
    ) ||
    db.search ||
    db.hash
  )
    throw Error("Refusing non-probe database URL");
  const publicOrigin = env.PROBE_PUBLIC_ORIGIN
    ? new URL(env.PROBE_PUBLIC_ORIGIN)
    : null;
  if (
    publicOrigin &&
    (publicOrigin.origin !== env.PROBE_PUBLIC_ORIGIN ||
      !["https:", "http:"].includes(publicOrigin.protocol))
  )
    throw Error("Invalid public origin");
  let workerOrigin = null;
  if (env.PROBE_WORKER_ORIGIN) {
    workerOrigin = new URL(env.PROBE_WORKER_ORIGIN);
    if (
      !["http:", "https:"].includes(workerOrigin.protocol) ||
      workerOrigin.username ||
      workerOrigin.password ||
      workerOrigin.pathname !== "/" ||
      workerOrigin.search ||
      workerOrigin.hash
    )
      throw Error("Fixed worker origin required");
  }
  const port = Number(
    role === "api"
      ? (env.PORT ?? env.PROBE_PORT ?? 8080)
      : (env.PROBE_INTERNAL_PORT ?? 8091),
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Invalid port");
  if (
    env.PROBE_DB_TLS === "false" &&
    !(
      env.NODE_ENV === "test" &&
      ["127.0.0.1", "localhost", "probe-db"].includes(db.hostname)
    )
  )
    throw Error("Plaintext DB permitted only for an isolated local test");
  return {
    role,
    run: env.PROBE_RUN_ID,
    expires,
    root,
    token: env.PROBE_TOKEN,
    internalKey: env.PROBE_INTERNAL_KEY,
    databaseUrl: db.href,
    workerOrigin,
    publicOrigin: publicOrigin?.origin,
    port,
    boot: randomUUID(),
    dbTls: env.PROBE_DB_TLS !== "false",
  };
}
export async function directory(root, run) {
  if (!uuid.test(run)) throw Error("Invalid run ID");
  let path = parse(root).root;
  for (const item of root
    .slice(path.length)
    .split("/")
    .filter(Boolean)
    .concat(run)) {
    path = join(path, item);
    await mkdir(path, { mode: 0o700 }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Unsafe probe folder");
  }
  return path;
}
export async function marker(config, role) {
  const path = join(await directory(config.root, config.run), `${role}.json`);
  const value = Buffer.from(
    JSON.stringify({ run: config.run, role, nonce: randomUUID() }),
  );
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  return inspect(config, role);
}
export async function inspect(config, role) {
  if (!["api", "worker"].includes(role)) throw Error("Invalid marker role");
  const path = join(await directory(config.root, config.run), `${role}.json`);
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 1024)
      throw Error("Unsafe marker");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let data;
    try {
      data = await file.readFile();
    } finally {
      await file.close();
    }
    const parsed = JSON.parse(data.toString());
    if (
      parsed.run !== config.run ||
      parsed.role !== role ||
      !uuid.test(parsed.nonce)
    )
      throw Error("Invalid marker");
    return { exists: true, hash: digest(data), bytes: data.length };
  } catch (e) {
    if (e.code === "ENOENT") return { exists: false };
    throw e;
  }
}
export function signature(key, run, time, nonce, data) {
  return createHmac("sha256", key)
    .update(`${run}\n${time}\n${nonce}\n${digest(data)}`)
    .digest("hex");
}
export function internalAuth(config, headers, data, seen, now = Date.now()) {
  const time = headers["x-probe-time"],
    nonce = headers["x-probe-nonce"],
    auth = headers["x-probe-signature"];
  for (const [key, expiry] of seen) if (expiry < now) seen.delete(key);
  if (
    !/^\d{13}$/.test(time ?? "") ||
    Math.abs(now - Number(time)) > 30000 ||
    !uuid.test(nonce ?? "") ||
    seen.has(nonce) ||
    seen.size >= 256 ||
    !equal(auth, signature(config.internalKey, config.run, time, nonce, data))
  )
    return false;
  seen.set(nonce, now + 30000);
  return true;
}
export const tables = {
  run: "axfluxo_connection_probe.runs",
  event: "axfluxo_connection_probe.events",
};
export async function validateDatabase(db) {
  const result = await db.query("SELECT current_database() AS name");
  if (!/^axfluxo[-_]probe[-_][a-z0-9_-]+$/.test(result.rows[0]?.name ?? ""))
    throw Error("Refusing non-probe database");
}
export async function armShare(db, config) {
  await validateDatabase(db);
  const file = await marker(config, "api");
  await db.query(
    `INSERT INTO ${tables.run}(id,expires_at,api_hash) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`,
    [config.run, new Date(config.expires), file.hash],
  );
  const row = (
    await db.query(`SELECT * FROM ${tables.run} WHERE id=$1`, [config.run])
  ).rows[0];
  if (row.api_hash !== file.hash)
    throw Error("Run ID already belongs to different API files; use a new run");
  return row;
}
export async function armWindow(db, config) {
  const result = await db.query(
    `UPDATE ${tables.run} SET armed_at=clock_timestamp(),window_end=clock_timestamp()+interval '90 seconds' WHERE id=$1 AND armed_at IS NULL AND expires_at>clock_timestamp()+interval '120 seconds' RETURNING armed_at,window_end`,
    [config.run],
  );
  if (result.rows.length) return result.rows[0];
  return (
    await db.query(
      `SELECT armed_at,window_end FROM ${tables.run} WHERE id=$1`,
      [config.run],
    )
  ).rows[0];
}
export async function workerTick(db, config) {
  const row = (
    await db.query(
      `SELECT *,clock_timestamp() AS db_now FROM ${tables.run} WHERE id=$1 AND expires_at>clock_timestamp()`,
      [config.run],
    )
  ).rows[0];
  if (!row) return { state: "waiting" };
  if (!row.worker_hash) {
    const api = await inspect(config, "api"),
      own = await marker(config, "worker");
    const shared = api.exists && api.hash === row.api_hash;
    await db.query(
      `UPDATE ${tables.run} SET worker_hash=$2,worker_saw_api=$3 WHERE id=$1 AND worker_hash IS NULL`,
      [config.run, own.hash, shared],
    );
  }
  // Re-inspect on each process boot through status observations, without overwriting markers.
  const api = await inspect(config, "api"),
    own = await inspect(config, "worker");
  await db.query(
    `INSERT INTO ${tables.event}(run_id,kind,slot,worker_boot,detail) SELECT $1,'boot',count(*)::integer,$2,$3::jsonb FROM ${tables.event} WHERE run_id=$1 AND kind='boot' HAVING count(*)<8 AND NOT EXISTS(SELECT 1 FROM ${tables.event} WHERE run_id=$1 AND kind='boot' AND worker_boot=$2) ON CONFLICT DO NOTHING`,
    [config.run, config.boot, JSON.stringify({ api, own })],
  );
  if (
    row.armed_at &&
    row.window_end &&
    new Date(row.db_now) < new Date(row.window_end)
  ) {
    const slot = Math.floor(
      (new Date(row.db_now) - new Date(row.armed_at)) / 5000,
    );
    if (slot >= 0 && slot < 18)
      await db.query(
        `INSERT INTO ${tables.event}(run_id,kind,slot,worker_boot,detail) VALUES($1,'db-window',$2,$3,'{"read":true,"write":true}') ON CONFLICT DO NOTHING`,
        [config.run, slot, config.boot],
      );
    return {
      state: "db-window",
      dbTime: row.db_now,
      windowEnd: row.window_end,
      boot: config.boot,
    };
  }
  return { state: "observing", boot: config.boot };
}
export async function report(db, config) {
  const row =
    (
      await db.query(
        `SELECT id,expires_at,api_hash,worker_hash,worker_saw_api,armed_at,window_end FROM ${tables.run} WHERE id=$1`,
        [config.run],
      )
    ).rows[0] ?? null;
  const apiSawWorker = await inspect(config, "worker"),
    apiFile = await inspect(config, "api");
  const events = (
    await db.query(
      `SELECT kind,slot,worker_boot,observed_at,detail FROM ${tables.event} WHERE run_id=$1 ORDER BY observed_at LIMIT 32`,
      [config.run],
    )
  ).rows;
  return {
    run: config.run,
    role: config.role,
    apiBoot: config.boot,
    expiresAt: new Date(config.expires).toISOString(),
    row,
    apiFile,
    apiSawWorker,
    bidirectionalShared:
      !!row?.worker_saw_api &&
      !!apiFile.exists &&
      apiFile.hash === row.api_hash &&
      !!apiSawWorker.exists &&
      apiSawWorker.hash === row.worker_hash,
    events,
    apiStopEvidence:
      "Operator must confirm API-part stopped timestamps in provider dashboard; this report does not infer a stop.",
  };
}
