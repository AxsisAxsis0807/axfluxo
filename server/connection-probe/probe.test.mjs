import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  session,
  validateDatabase,
  inspect,
  configuration,
  signature,
  internalAuth,
  armShare,
  armWindow,
  workerTick,
  report,
} from "./core.mjs";
import { setup } from "./lifecycle.mjs";
import { start } from "./main.mjs";
function env() {
  return {
    NODE_ENV: "test",
    PROBE_DB_TLS: "false",
    PROBE_ROLE: "api",
    PROBE_RUN_ID: randomUUID(),
    PROBE_DATABASE_NAME: "axfluxo_probe_local",
    PROBE_DEDICATED_DATABASE: "new-empty-probe-only",
    PROBE_TOKEN: "synthetic-probe-ui-token-for-local-tests-only",
    PROBE_INTERNAL_KEY: "synthetic-probe-internal-key-for-local-tests-only",
    PROBE_ROOT: "/tmp/probe",
    PROBE_DATABASE_URL: "postgres://probe@127.0.0.1/axfluxo_probe_local",
    PROBE_PORT: "8080",
  };
}
test("requires matching DB confirmation, valid identity and verified remote TLS", () => {
  for (const changed of [
    { PROBE_DATABASE_URL: "postgres://user@db/axfluxo" },
    { PROBE_RUN_ID: "../bad" },
    { PROBE_DATABASE_NAME: "wrong" },
    {
      PROBE_DATABASE_URL: "postgres://user@remote/axfluxo_probe_test",
      PROBE_DB_TLS: "false",
    },
  ])
    assert.throws(() => configuration({ ...env(), ...changed }));
  assert.equal(configuration(env()).role, "api");
});
test("internal HMAC rejects missing/wrong/expired signatures and replay", () => {
  const config = configuration(env()),
    data = Buffer.from("{}"),
    time = String(Date.now()),
    nonce = randomUUID(),
    seen = new Map();
  const headers = {
    "x-probe-time": time,
    "x-probe-nonce": nonce,
    "x-probe-signature": signature(
      config.internalKey,
      config.run,
      time,
      nonce,
      data,
    ),
  };
  assert.equal(internalAuth(config, {}, data, seen), false);
  assert.equal(
    internalAuth(
      config,
      { ...headers, "x-probe-signature": "bad" },
      data,
      seen,
    ),
    false,
  );
  assert.equal(internalAuth(config, headers, data, seen), true);
  assert.equal(internalAuth(config, headers, data, seen), false);
  assert.equal(
    internalAuth(
      config,
      { ...headers, "x-probe-nonce": randomUUID() },
      data,
      seen,
      Date.now() + 60000,
    ),
    false,
  );
});
test("separates shared folder, nonshared folder, signed internal HTTP and API-off DB observations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axfluxo-probe-check-"));
  let db, closeDB;
  const native = process.env.AXFLUXO_PROBE_TEST_DATABASE_URL;
  if (native) {
    const url = new URL(native);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.match(url.pathname, /^\/axfluxo[-_]probe[-_]/);
    const pool = new Pool({ connectionString: native });
    db = { query: (...a) => pool.query(...a), connect: () => pool.connect() };
    closeDB = () => pool.end();
  } else {
    const { PGlite } = await import(
      process.env.PROBE_PGLITE_MODULE || "@electric-sql/pglite"
    );
    const dataDir = join(dir, "db");
    const bootstrap = new PGlite(dataDir);
    await bootstrap.waitReady;
    await bootstrap.exec("CREATE DATABASE axfluxo_probe_local");
    await bootstrap.close();
    const p = new PGlite({ dataDir, database: "axfluxo_probe_local" });
    await p.waitReady;
    db = {
      query: (sql, params) =>
        params ? p.query(sql, params) : p.exec(sql).then((r) => r.at(-1)),
      connect: async () => ({
        query: (sql, params) => db.query(sql, params),
        release() {},
      }),
    };
    closeDB = () => p.close();
  }
  let api, worker;
  try {
    const config = {
      ...configuration(env()),
      root: join(dir, "shared"),
      port: 0,
    };
    await db.query("CREATE TABLE public.existing_data(value text)");
    await db.query("INSERT INTO public.existing_data VALUES('preserve')");
    await assert.rejects(setup(db, config), /DB_NOT_EMPTY/);
    assert.equal(
      (await db.query("SELECT value FROM public.existing_data")).rows[0].value,
      "preserve",
    );
    await db.query("DROP TABLE public.existing_data");
    await db.query("CREATE SCHEMA axfluxo_connection_probe");
    await assert.rejects(setup(db, config), /PROBE_SCHEMA_UNVERIFIED/);
    await db.query("DROP SCHEMA axfluxo_connection_probe");
    if (native)
      assert.deepEqual(
        (await Promise.all([setup(db, config), setup(db, config)])).map(
          (r) => r.state,
        ),
        ["ready", "ready"],
      );
    assert.equal((await setup(db, config)).state, "ready");
    assert.equal((await setup(db, config)).state, "ready");
    await assert.rejects(
      setup(db, { ...config, run: randomUUID() }),
      /SESSION_ID_MISMATCH/,
    );
    const first = await session(db, config, true);
    const again = await session(db, { ...config }, true);
    assert.equal(
      new Date(first.expiresAt).getTime(),
      new Date(again.expiresAt).getTime(),
    );
    assert.ok(config.expires - Date.now() <= 1800000);
    await assert.rejects(
      validateDatabase(db, { ...config, expectedDatabase: "other" }),
      /DB_IDENTITY_MISMATCH/,
    );
    await armShare(db, config);
    const workerConfig = {
      ...config,
      role: "worker",
      boot: randomUUID(),
      port: 0,
    };
    await workerTick(db, workerConfig);
    assert.equal((await report(db, config)).bidirectionalShared, true);
    await workerTick(db, workerConfig);
    assert.equal(
      (await report(db, config)).events.filter((e) => e.kind === "boot").length,
      1,
    );
    const missing = {
      ...config,
      run: randomUUID(),
      root: join(dir, "api-only"),
    };
    await armShare(db, missing);
    await workerTick(db, {
      ...missing,
      root: join(dir, "worker-only"),
      role: "worker",
      boot: randomUUID(),
    });
    const noShare = await report(db, missing);
    assert.equal(noShare.row.worker_saw_api, false);
    assert.equal(noShare.bidirectionalShared, false);
    worker = await start(workerConfig, db);
    const workerPort = worker.server.address().port;
    const apiConfig = {
      ...config,
      workerOrigin: new URL(`http://127.0.0.1:${workerPort}`),
    };
    api = await start(apiConfig, db);
    const origin = `http://127.0.0.1:${api.server.address().port}`;
    const request = (path, auth = config.token, body = "{}") =>
      fetch(origin + path, {
        method: path === "/v1/report" ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + auth,
          "content-type": "application/json",
        },
        body: path === "/v1/report" ? undefined : body,
      });
    assert.equal((await request("/v1/share", "bad")).status, 401);
    assert.equal((await request("/v1/setup", "bad")).status, 401);
    assert.equal((await request("/v1/start", "bad")).status, 401);
    const http = await request("/v1/internal-http");
    assert.equal(http.status, 200);
    assert.equal((await http.json()).state, "pass");
    for (let i = 0; i < 2; i++)
      assert.equal((await request("/v1/internal-http")).status, 200);
    assert.equal((await request("/v1/internal-http")).status, 409);
    await armWindow(db, config);
    await worker.close();
    worker = await start({ ...workerConfig, boot: randomUUID() }, db);
    await api.close();
    api = null;
    const stoppedAt = Date.now();
    // A real HTTP listener is stopped. Worker keeps its own scheduler, with no API requests.
    await new Promise((resolve) => setTimeout(resolve, 5300));
    const evidence = await report(db, config);
    assert.ok(
      evidence.events.some(
        (e) =>
          e.kind === "db-window" &&
          new Date(e.observed_at).getTime() > stoppedAt,
      ),
    );
    assert.match(evidence.apiStopEvidence, /Operator must confirm/);
    assert.equal(JSON.stringify(evidence).includes(config.token), false);
    const repeated = await armWindow(db, config);
    assert.equal(
      new Date(repeated.armed_at).getTime(),
      new Date(evidence.row.armed_at).getTime(),
    );
    const bootCount = evidence.events.filter((e) => e.kind === "boot").length;
    assert.equal(bootCount, 2);
    const expiredConfig = { ...workerConfig, expires: Date.now() - 1 };
    let calls = 0;
    const expired = await start(expiredConfig, {
      query: async (...args) => {
        calls++;
        return db.query(...args);
      },
    });
    const before = calls;
    await expired.tick();
    assert.equal(calls, before);
    await expired.close();
    await db.query(`UPDATE axfluxo_connection_probe.session
      SET started_at=statement_timestamp()-interval '31 minutes',
          expires_at=statement_timestamp()-interval '1 minute'`);
    assert.equal(
      (await session(db, { ...config, expires: Infinity }, true)).state,
      "expired",
    );
  } finally {
    await api?.close();
    await worker?.close();
    await closeDB?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("API boots without DB and reveals configuration only after authentication", async () => {
  const config = {
    ...configuration({
      ...env(),
      PROBE_DATABASE_URL: undefined,
      PROBE_DATABASE_NAME: undefined,
      PROBE_DB_TLS: "true",
    }),
    port: 0,
  };
  let calls = 0;
  const app = await start(config, {
    query: async () => {
      calls++;
      throw Error("secret-host-and-password");
    },
  });
  try {
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal(calls, 0);
    assert.equal((await fetch(origin + "/health")).status, 200);
    const hidden = await fetch(origin + "/v1/status");
    assert.equal(hidden.status, 401);
    assert.equal((await hidden.text()).includes("DATABASE"), false);
    const state = await fetch(origin + "/v1/status", {
      headers: { authorization: `Bearer ${config.token}` },
    });
    assert.equal((await state.json()).state, "DATABASE_URL_MISSING");
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test("storage errors remain distinguishable without exposing filesystem paths", async () => {
  await assert.rejects(
    inspect({ ...configuration(env()), root: "/dev/null/probe" }, "api"),
    (error) =>
      error.code === "PROBE_STORAGE_UNAVAILABLE" &&
      !error.message.includes("/dev/null"),
  );
});
