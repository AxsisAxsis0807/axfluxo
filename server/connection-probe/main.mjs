import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  session,
  configuration,
  digest,
  equal,
  signature,
  internalAuth,
  validateDatabase,
  armShare,
  armWindow,
  workerTick,
  report,
} from "./core.mjs";
import { setup } from "./lifecycle.mjs";
export function handler(config, db) {
  const seen = new Map();
  let requests = 0,
    start = Date.now();
  return async (req, res) => {
    const send = (status, body, type = "application/json") => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    try {
      const path = new URL(req.url, "http://probe").pathname;
      if (req.method === "GET" && path === "/health")
        return send(200, {
          ok: true,
        });
      if (req.method === "GET" && path === "/" && config.role === "api")
        return send(
          200,
          await readFile(new URL("./ui.html", import.meta.url), "utf8"),
          "text/html; charset=utf-8",
        );
      if (Date.now() - start > 60000) {
        requests = 0;
        start = Date.now();
      }
      if (++requests > 30) return send(429, { error: "RATE_LIMITED" });
      if (req.headers.origin && req.headers.origin !== config.publicOrigin)
        return send(403, { error: "ORIGIN_REJECTED" });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4096) {
          send(413, { error: "BODY_LIMIT" });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      if (
        path === "/internal/check" &&
        req.method === "POST" &&
        config.role === "worker"
      ) {
        if (!internalAuth(config, req.headers, data, seen))
          return send(401, { error: "INTERNAL_AUTH_REQUIRED" });
        const state = await session(db, config);
        if (state.state !== "active") return send(410, { error: "NOT_ACTIVE" });
        const input = JSON.parse(data.toString());
        if (
          input.run !== config.run ||
          typeof input.canary !== "string" ||
          input.canary.length > 256
        )
          return send(400, { error: "INVALID_CANARY" });
        const body = Buffer.from(
          JSON.stringify({
            run: config.run,
            workerBoot: config.boot,
            digest: digest(data),
          }),
        );
        return send(200, {
          body: body.toString("base64"),
          signature: signature(
            config.internalKey,
            config.run,
            req.headers["x-probe-time"],
            req.headers["x-probe-nonce"],
            body,
          ),
        });
      }
      if (
        config.role !== "api" ||
        !equal(req.headers.authorization, `Bearer ${config.token}`)
      )
        return send(401, { error: "PROBE_AUTH_REQUIRED" });
      if (req.method === "GET" && path === "/v1/status") {
        if (!config.databaseUrl)
          return send(200, { state: "DATABASE_URL_MISSING" });
        if (!config.expectedDatabase || !config.dedicated)
          return send(200, { state: "DB_CONFIRMATION_REQUIRED" });
        await validateDatabase(db, config);
        const exists = (
          await db.query(
            "SELECT 1 FROM pg_namespace WHERE nspname='axfluxo_connection_probe'",
          )
        ).rows.length;
        return send(200, {
          ...(exists ? await session(db, config) : { state: "SETUP_REQUIRED" }),
          workerOriginConfigured: !!config.workerOrigin,
          storage: "UNCONFIRMED_UNTIL_RESTART_AND_HASH_COMPARISON",
        });
      }
      if (
        req.method === "POST" &&
        data.toString() === "{}" &&
        path === "/v1/setup"
      )
        return send(200, await setup(db, config));
      if (
        req.method === "POST" &&
        data.toString() === "{}" &&
        path === "/v1/start"
      )
        return send(200, await session(db, config, true));
      const state = await session(db, config);
      if (req.method === "GET" && path === "/v1/report")
        return send(200, await report(db, config));
      if (state.state !== "active")
        return send(410, { error: "NOT_ACTIVE", state: state.state });
      if (req.method !== "POST" || data.toString() !== "{}")
        return send(400, { error: "EMPTY_JSON_REQUIRED" });
      if (path === "/v1/share") {
        await armShare(db, config);
        return send(200, { state: "armed", run: config.run });
      }
      if (path === "/v1/db-window") {
        const window = await armWindow(db, config);
        return send(
          window?.armed_at ? 200 : 409,
          window?.armed_at
            ? window
            : {
                error: "START_SHARE_FIRST_AND_ALLOW_120_SECONDS_BEFORE_EXPIRY",
              },
        );
      }
      if (path === "/v1/internal-http") {
        if (!config.workerOrigin)
          return send(409, {
            state: "not-configured",
            reason:
              "Set the fixed internal worker origin after checking provider settings",
          });
        const budget =
          await db.query(`UPDATE axfluxo_connection_probe.session SET http_attempts=http_attempts+1
          WHERE singleton=true AND http_attempts<3 RETURNING http_attempts`);
        if (!budget.rows.length)
          return send(409, { error: "HTTP_ATTEMPT_LIMIT" });
        const body = Buffer.from(
          JSON.stringify({
            run: config.run,
            canary: "axfluxo-connectivity-only",
          }),
        );
        const time = String(Date.now()),
          nonce = randomUUID(),
          mac = signature(config.internalKey, config.run, time, nonce, body);
        const url = new URL("/internal/check", config.workerOrigin);
        const call = (auth) =>
          fetch(url, {
            method: "POST",
            body,
            headers: { "content-type": "application/json", ...auth },
            redirect: "error",
            signal: AbortSignal.timeout(3000),
          });
        try {
          const unauth = await call({});
          const rejected = unauth.status === 401;
          await unauth.body?.cancel();
          const signedHeaders = {
            "x-probe-time": time,
            "x-probe-nonce": nonce,
            "x-probe-signature": mac,
          };
          const response = await call(signedHeaders);
          const reply = [];
          let received = 0;
          for await (const chunk of response.body) {
            received += chunk.byteLength;
            if (received > 4096) throw Error("INVALID_RESPONSE");
            reply.push(chunk);
          }
          const raw = Buffer.concat(reply).toString();
          const parsed = JSON.parse(raw),
            responseBody = Buffer.from(parsed.body ?? "", "base64");
          const signed =
            response.status === 200 &&
            equal(
              parsed.signature,
              signature(
                config.internalKey,
                config.run,
                time,
                nonce,
                responseBody,
              ),
            );
          const contents = signed ? JSON.parse(responseBody) : null;
          const replay = await call(signedHeaders);
          const replayRejected = replay.status === 401;
          await replay.body?.cancel();
          return send(200, {
            state:
              rejected &&
              signed &&
              replayRejected &&
              contents.run === config.run &&
              contents.digest === digest(body)
                ? "pass"
                : "fail",
            unauthenticatedRejected: rejected,
            signedResponseVerified: signed,
            replayRejected,
            workerBoot: contents?.workerBoot ?? null,
          });
        } catch {
          return send(200, {
            state: "unconfirmed",
            reason: "INTERNAL_UNREACHABLE_TIMEOUT_OR_INVALID_RESPONSE",
          });
        }
      }
      return send(404, { error: "NOT_FOUND" });
    } catch (error) {
      const safe = [
        "DB_CONFIRMATION_REQUIRED",
        "DB_IDENTITY_MISMATCH",
        "DB_NOT_EMPTY",
        "SESSION_ID_MISMATCH",
        "PROBE_SCHEMA_UNVERIFIED",
      ];
      return send(503, {
        error:
          error.code === "PROBE_STORAGE_UNAVAILABLE"
            ? "STORAGE_UNAVAILABLE"
            : safe.includes(error.message)
              ? error.message
              : error.code === "42P01"
                ? "SETUP_REQUIRED"
                : error.code === "42501"
                  ? "DB_PERMISSION_DENIED"
                  : [
                        "CERT_HAS_EXPIRED",
                        "DEPTH_ZERO_SELF_SIGNED_CERT",
                        "SELF_SIGNED_CERT_IN_CHAIN",
                        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
                      ].includes(error.code)
                    ? "DB_TLS_FAILED"
                    : "DB_OR_MARKER_UNAVAILABLE",
        note: "Check sanitized worker logs; no credentials or raw driver errors are returned",
      });
    }
  };
}
export async function start(config, db) {
  const server = createServer(
    {
      requestTimeout: 10000,
      connectionsCheckingInterval: 1000,
      headersTimeout: 5000,
      maxHeaderSize: 8192,
    },
    handler(config, db),
  );
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", resolve);
  });
  let timer,
    windowDeadline,
    active = false,
    closing = false;
  const tick = async () => {
    if (
      active ||
      closing ||
      Date.now() >= config.expires ||
      (windowDeadline && Date.now() >= windowDeadline)
    ) {
      if (
        Date.now() >= config.expires ||
        (windowDeadline && Date.now() >= windowDeadline)
      )
        clearInterval(timer);
      return;
    }
    active = true;
    try {
      const state = await session(db, config);
      if (state.state !== "active") return { state: state.state };
      const result = await workerTick(db, config);
      if (result.state === "db-window")
        console.log(JSON.stringify({ event: "db-window", ...result }));
      else clearInterval(timer);
      return result;
    } catch (error) {
      console.log(
        JSON.stringify({
          event:
            error.code === "PROBE_STORAGE_UNAVAILABLE"
              ? "STORAGE_UNAVAILABLE"
              : "DB_UNAVAILABLE_OR_NOT_INITIALIZED",
          at: new Date().toISOString(),
          boot: config.boot,
        }),
      );
    } finally {
      active = false;
    }
  };
  if (config.role === "worker") {
    const initial = await tick();
    if (initial?.state === "db-window") {
      windowDeadline = new Date(initial.windowEnd).getTime();
      timer = setInterval(tick, 5000);
    }
    // No idle DB polling. After arming in the API, manually restart ONLY worker.
  }
  console.log(
    JSON.stringify({
      event: "ready",
      role: config.role,
      boot: config.boot,
      expiresAt: Number.isFinite(config.expires)
        ? new Date(config.expires).toISOString()
        : null,
    }),
  );
  return {
    server,
    tick,
    async close() {
      closing = true;
      clearInterval(timer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await db.end?.();
    },
  };
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    const config = configuration(process.env);
    const db = config.databaseUrl
      ? new Pool({
          connectionString: config.databaseUrl,
          max: 1,
          connectionTimeoutMillis: 2000,
          query_timeout: 3000,
          statement_timeout: 2000,
          ssl: config.dbTls ? { rejectUnauthorized: true } : false,
        })
      : {
          query: async () => {
            throw Error("DB_CONFIRMATION_REQUIRED");
          },
          connect: async () => {
            throw Error("DB_CONFIRMATION_REQUIRED");
          },
        };
    db.on?.("error", () => console.log('{"event":"DB_POOL_UNAVAILABLE"}'));
    const app = await start(config, db);
    const close = () => {
      const deadline = setTimeout(() => process.exit(1), 10000);
      void app.close().finally(() => {
        clearTimeout(deadline);
        process.exit(0);
      });
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  } catch {
    console.error(
      "Probe startup refused. Check probe-only DB, role, expiry, schema, TLS and configuration.",
    );
    process.exitCode = 1;
  }
}
