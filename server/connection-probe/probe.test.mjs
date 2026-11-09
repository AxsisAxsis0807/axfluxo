import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  configuration,
  signature,
  internalAuth,
  armShare,
  armWindow,
  workerTick,
  report,
} from "./core.mjs";
import { start } from "./main.mjs";
function env() {
  return {
    NODE_ENV: "test",
    PROBE_DB_TLS: "false",
    PROBE_ROLE: "api",
    PROBE_RUN_ID: randomUUID(),
    PROBE_EXPIRES_AT: new Date(Date.now() + 600000).toISOString(),
    PROBE_TOKEN: "synthetic-probe-ui-token-for-local-tests-only",
    PROBE_INTERNAL_KEY: "synthetic-probe-internal-key-for-local-tests-only",
    PROBE_ROOT: "/tmp/probe",
    PROBE_DATABASE_URL: "postgres://probe@127.0.0.1/axfluxo_probe_local",
    PROBE_PORT: "8080",
  };
}
test("refuses production DBs, excessive lifetime, invalid identity and plaintext remote DB", () => {
  for (const changed of [
    { PROBE_DATABASE_URL: "postgres://user@db/axfluxo" },
    { PROBE_RUN_ID: "../bad" },
    { PROBE_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString() },
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
  let db, closeDB, execSQL;
  const native = process.env.AXFLUXO_PROBE_TEST_DATABASE_URL;
  if (native) {
    const url = new URL(native);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.match(url.pathname, /^\/axfluxo[-_]probe[-_]/);
    const pool = new Pool({ connectionString: native });
    db = { query: (...a) => pool.query(...a) };
    closeDB = () => pool.end();
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dataDir = join(dir, "db");
    const bootstrap = new PGlite(dataDir);
    await bootstrap.waitReady;
    await bootstrap.exec("CREATE DATABASE axfluxo_probe_local");
    await bootstrap.close();
    const p = new PGlite({ dataDir, database: "axfluxo_probe_local" });
    await p.waitReady;
    db = { query: (...a) => p.query(...a) };
    execSQL = (text) => p.exec(text);
    closeDB = () => p.close();
  }
  let api, worker;
  try {
    const setup = await readFile(
      new URL("./setup.sql", import.meta.url),
      "utf8",
    );
    if (native) await db.query(setup);
    else await execSQL(setup);
    const config = {
      ...configuration(env()),
      root: join(dir, "shared"),
      port: 0,
    };
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
    const http = await request("/v1/internal-http");
    assert.equal(http.status, 200);
    assert.equal((await http.json()).state, "pass");
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
  } finally {
    await api?.close();
    await worker?.close();
    await closeDB?.();
    await rm(dir, { recursive: true, force: true });
  }
});
