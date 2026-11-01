import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testEngine, type TestEngine } from "./engine";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoApi } from "../api/app";
import { jwtVerifier } from "../api/auth";
import type { Database, Sql } from "../db/database";

const issuer = "https://example.supabase.co/auth/v1",
  audience = "authenticated",
  origin = "https://editor.example";
const clock = Math.floor(Date.now() / 1000);
let pg: TestEngine, directory: string;
let privateKey: CryptoKey;
let verify: ReturnType<typeof jwtVerifier>;
let owner: string, other: string, bearer: string;
let enabled = true;
let failOn = "";
const db: Database = {
  transaction: (work) =>
    pg.transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE axfluxo_video_api");
      const sql: Sql = {
        query: async (text, values) => {
          if (failOn && text.includes(failOn))
            throw new Error(
              "secret database details https://signed.example?token=secret",
            );
          return tx.query(text, values);
        },
      };
      return work(sql);
    }),
};
const app = () =>
  createVideoApi({
    db,
    verify,
    allowedOrigins: [origin],
    admissionEnabled: () => enabled,
    unitsPerFrame: 1,
  });
async function token(
  subject: string,
  claims: JWTPayload = {},
  key = privateKey,
) {
  return new SignJWT({ role: "authenticated", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(clock)
    .setExpirationTime(clock + 3600)
    .sign(key);
}
function snapshot(subject = owner) {
  return {
    schemaVersion: 1,
    id: "snap",
    document: {
      schemaVersion: 1,
      kind: "all-versions",
      id: "doc",
      revision: 0,
      clips: [
        {
          id: "clip",
          source: {
            libraryId: `lib-${subject}`,
            fileId: "file",
            versionId: "v1",
            hash: "a".repeat(64),
            kind: "video",
          },
          sourceDurationUs: 1_000_000,
          interval: { startUs: 0, endUs: 1_000_000 },
          markersUs: [],
        },
      ],
      fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
    },
    ranges: [{ startUs: 0, endUs: 1_000_000 }],
    names: ["chart.mp4"],
  };
}
async function send(
  path = "/render-batches",
  options: {
    auth?: string | null;
    body?: unknown;
    key?: string;
    method?: string;
    origin?: string;
    api?: ReturnType<typeof app>;
  } = {},
) {
  const method =
    options.method ??
    (path === "/v1/developer/me" || /^\/render-batches\//.test(path)
      ? "GET"
      : "POST");
  const headers = new Headers({ origin: options.origin ?? origin });
  if (options.auth !== null)
    headers.set("authorization", `Bearer ${options.auth ?? bearer}`);
  if (method === "POST") {
    headers.set("content-type", "application/json");
    headers.set("idempotency-key", options.key ?? randomUUID());
  }
  const request = new Request(`https://api.example${path}`, {
    method,
    headers,
    body:
      method === "POST"
        ? JSON.stringify(
            options.body ??
              (path === "/render-batches" ? { snapshot: snapshot() } : {}),
          )
        : undefined,
  });
  return (options.api ?? app())(request);
}
async function counts() {
  const names = [
    "render_batches",
    "render_jobs",
    "outbox_events",
    "usage_reservations",
    "resource_pins",
    "audit_events",
    "idempotency_requests",
  ];
  return Promise.all(
    names.map(
      async (name) =>
        (
          await pg.query<{ count: number }>(
            `SELECT count(*)::integer AS count FROM axfluxo_video.${name} WHERE owner_id=$1`,
            [owner],
          )
        ).rows[0].count,
    ),
  );
}
async function reserved() {
  return (
    await pg.query<{ reserved_units: number }>(
      "SELECT reserved_units FROM axfluxo_video.usage_budgets WHERE owner_id=$1",
      [owner],
    )
  ).rows[0].reserved_units;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "axfluxo-video-v1-"));
  pg = testEngine(directory);
  await pg.exec(
    await readFile(
      new URL("../db/migrations/001_video_foundation.sql", import.meta.url),
      "utf8",
    ),
  );
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  verify = jwtVerifier(
    createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "ES256" }] }),
    { issuer, audience, now: () => new Date(clock * 1000) },
  );
}, 30000);
beforeEach(async () => {
  owner = randomUUID();
  other = randomUUID();
  enabled = true;
  failOn = "";
  for (const id of [owner, other]) {
    await pg.query(
      "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES ($1,true)",
      [id],
    );
    await pg.query(
      "INSERT INTO axfluxo_video.usage_budgets(owner_id,limit_units) VALUES ($1,10000)",
      [id],
    );
    await pg.query(
      "INSERT INTO axfluxo_video.resource_versions(owner_id,library_id,file_id,version_id,hash,kind) VALUES ($1,$2,'file','v1',$3,'video')",
      [id, `lib-${id}`, "a".repeat(64)],
    );
  }
  bearer = await token(owner);
});
afterAll(async () => {
  await pg?.close();
});
describe("real PostgreSQL engine + signed JWT + HTTP handler", () => {
  it("rejects absent, malformed and forged JWT", async () => {
    expect((await send("/v1/developer/me", { auth: null })).status).toBe(401);
    expect((await send("/v1/developer/me", { auth: "invalid" })).status).toBe(
      401,
    );
    const bad = await generateKeyPair("ES256");
    expect(
      (
        await send("/v1/developer/me", {
          auth: await token(owner, {}, bad.privateKey),
        })
      ).status,
    ).toBe(401);
    expect(await counts()).toEqual(Array(7).fill(0));
  });
  it("verifies expiry, issuer, audience, nbf and required claims", async () => {
    const build = (claims: JWTPayload) =>
      new SignJWT({
        role: "authenticated",
        sub: owner,
        iss: issuer,
        aud: audience,
        iat: clock,
        exp: clock + 100,
        ...claims,
      })
        .setProtectedHeader({ alg: "ES256", kid: "test" })
        .sign(privateKey);
    const expired = await send("/v1/developer/me", {
      auth: await build({ exp: clock - 1 }),
    });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: { code: "AUTH_EXPIRED" } });
    for (const claims of [
      { iss: "https://attacker.example" },
      { aud: "other" },
      { nbf: clock + 100 },
      { exp: undefined },
      { iat: clock + 10 },
      { role: "service_role" },
    ])
      expect(
        (await send("/v1/developer/me", { auth: await build(claims) })).status,
      ).toBe(401);
  });
  it("ordinary users cannot elevate through user metadata", async () => {
    const normal = await token(randomUUID(), {
      user_metadata: { role: "developer", is_developer: true, owner_id: owner },
    });
    expect((await send("/v1/developer/me", { auth: normal })).status).toBe(403);
    expect((await send("/render-batches", { auth: normal })).status).toBe(403);
  });
  it("checks membership revocation/expiry on reads, writes and duplicate replays", async () => {
    const key = randomUUID(),
      accepted = await send("/render-batches", { key });
    const batch = await accepted.json();
    expect(accepted.status).toBe(202);
    await pg.query(
      "UPDATE axfluxo_video.developer_memberships SET active=false WHERE owner_id=$1",
      [owner],
    );
    for (const path of [
      "/v1/developer/me",
      `/render-batches/${batch.id}`,
      `/render-jobs/${batch.jobs[0].id}/retry`,
      `/render-jobs/${batch.jobs[0].id}/cancel`,
    ])
      expect((await send(path)).status).toBe(403);
    expect((await send("/render-batches", { key })).status).toBe(403);
    await pg.query(
      "UPDATE axfluxo_video.developer_memberships SET active=true,expires_at=now()-interval '1 second' WHERE owner_id=$1",
      [owner],
    );
    expect((await send("/v1/developer/me")).status).toBe(403);
  });
  it("never exposes another owner's batch, job, output or original", async () => {
    const batch = await (await send()).json(),
      foreign = await token(other);
    expect(
      (await send(`/render-batches/${batch.id}`, { auth: foreign })).status,
    ).toBe(404);
    for (const action of ["retry", "cancel"])
      expect(
        (
          await send(`/render-jobs/${batch.jobs[0].id}/${action}`, {
            auth: foreign,
          })
        ).status,
      ).toBe(404);
    expect(
      (await send("/render-batches", { body: { snapshot: snapshot(other) } }))
        .status,
    ).toBe(404);
    expect(
      (
        await send("/render-batches", {
          body: { snapshot: snapshot(), owner_id: other },
        })
      ).status,
    ).toBe(400);
    const wrong = snapshot();
    wrong.document.clips[0].source.hash = "b".repeat(64);
    expect(
      (await send("/render-batches", { body: { snapshot: wrong } })).status,
    ).toBe(404);
  });
  it("uses owner-scoped unique keys, canonical snapshots and 409 for different content/operation", async () => {
    const key = randomUUID();
    const first = await send("/render-batches", { key }),
      second = await send("/render-batches", { key });
    expect(first.status).toBe(202);
    expect(await second.json()).toEqual(await first.json());
    const changed = snapshot();
    changed.id = "changed";
    expect(
      (await send("/render-batches", { key, body: { snapshot: changed } }))
        .status,
    ).toBe(409);
    const batch = await (await send("/render-batches", { key })).json();
    expect(
      (await send(`/render-jobs/${batch.jobs[0].id}/cancel`, { key })).status,
    ).toBe(409);
    expect(
      (
        await send("/render-batches", {
          key,
          auth: await token(other),
          body: { snapshot: snapshot(other) },
        })
      ).status,
    ).toBe(202);
    expect(Number(await reserved())).toBe(60);
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
  it("coalesces concurrent duplicate submissions into one durable job/outbox/reservation", async () => {
    const key = randomUUID();
    const responses = await Promise.all([
      send("/render-batches", { key }),
      send("/render-batches", { key }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([202, 202]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(Number(await reserved())).toBe(60);
  });
  it("rolls back jobs, pins, budget, idempotency and outbox when a transaction fails halfway", async () => {
    failOn = "INSERT INTO axfluxo_video.outbox_events";
    const key = randomUUID(),
      response = await send("/render-batches", { key });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/secret|signed|token|database/);
    expect(await counts()).toEqual(Array(7).fill(0));
    expect(Number(await reserved())).toBe(0);
    failOn = "";
    expect((await send("/render-batches", { key })).status).toBe(202);
  });
  it("rolls back on a PostgreSQL trigger failure after staging the job and reservation", async () => {
    await pg.exec(`CREATE FUNCTION axfluxo_video.test_abort_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.owner_id = '${owner}'::uuid THEN RAISE EXCEPTION 'test-only transaction failure' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_abort_outbox BEFORE INSERT ON axfluxo_video.outbox_events FOR EACH ROW EXECUTE FUNCTION axfluxo_video.test_abort_outbox();`);
    expect((await send()).status).toBe(500);
    expect(await counts()).toEqual(Array(7).fill(0));
    expect(Number(await reserved())).toBe(0);
  });
  it("fails closed with missing budget/price and serializes competing budget reservations", async () => {
    await pg.query(
      "UPDATE axfluxo_video.usage_budgets SET limit_units=NULL WHERE owner_id=$1",
      [owner],
    );
    expect((await send()).status).toBe(503);
    expect(await counts()).toEqual(Array(7).fill(0));
    await pg.query(
      "UPDATE axfluxo_video.usage_budgets SET limit_units=60 WHERE owner_id=$1",
      [owner],
    );
    const noPrice = createVideoApi({
      db,
      verify,
      allowedOrigins: [origin],
      admissionEnabled: () => true,
    });
    expect((await send("/render-batches", { api: noPrice })).status).toBe(503);
    const responses = await Promise.all([send(), send()]);
    expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(Number(await reserved())).toBe(60);
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
  it("retry creates one new attempt with reservation/outbox and keeps the original snapshot", async () => {
    const batch = await (await send()).json(),
      original = batch.jobs[0].id;
    expect((await send(`/render-jobs/${original}/retry`)).status).toBe(409);
    await pg.query(
      "UPDATE axfluxo_video.render_jobs SET state='failed' WHERE id=$1",
      [original],
    );
    const key = randomUUID(),
      result = await send(`/render-jobs/${original}/retry`, { key });
    expect(result.status).toBe(202);
    const retry = await result.json();
    expect(retry.job).toMatchObject({
      retryOf: original,
      attempt: 2,
      state: "queued",
    });
    expect(
      await (await send(`/render-jobs/${original}/retry`, { key })).json(),
    ).toEqual(retry);
    expect((await send(`/render-jobs/${original}/retry`)).status).toBe(409);
    const read = await (await send(`/render-batches/${batch.id}`)).json();
    expect(read.jobs).toHaveLength(2);
    expect(Number(await reserved())).toBe(120);
    expect(await counts()).toEqual([1, 2, 2, 2, 2, 2, 2]);
  });
  it("cancellation is persistent/idempotent without releasing pins or budget prematurely", async () => {
    const batch = await (await send()).json(),
      path = `/render-jobs/${batch.jobs[0].id}/cancel`,
      key = randomUUID();
    const response = await send(path, { key });
    expect(response.status).toBe(202);
    const cancelled = await response.json();
    expect(cancelled.job.state).toBe("cancel_requested");
    expect(await (await send(path, { key })).json()).toEqual(cancelled);
    expect((await send(path)).status).toBe(202);
    expect(Number(await reserved())).toBe(60);
    expect(
      (
        await pg.query(
          "SELECT * FROM axfluxo_video.outbox_events WHERE owner_id=$1 AND event_type='cancel.requested'",
          [owner],
        )
      ).rows,
    ).toHaveLength(1);
    enabled = false;
    expect((await send()).status).toBe(503);
    expect((await send(`/render-batches/${batch.id}`)).status).toBe(200);
    expect((await send(path)).status).toBe(202);
  });
  it("enforces RLS and least privileges even if application filters are omitted", async () => {
    await send();
    await db.transaction(async (sql) => {
      await sql.query("SELECT set_config('axfluxo.owner_id',$1,true)", [other]);
      expect(
        (await sql.query("SELECT * FROM axfluxo_video.render_batches")).rows,
      ).toHaveLength(0);
    });
    for (const statement of [
      "UPDATE axfluxo_video.developer_memberships SET active=true",
      "UPDATE axfluxo_video.usage_budgets SET limit_units=999999",
      "DELETE FROM axfluxo_video.render_outputs",
      "INSERT INTO axfluxo_video.resource_versions(owner_id,library_id,file_id,version_id,hash,kind) VALUES ('11111111-1111-4111-8111-111111111111','x','y','z','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','video')",
    ])
      await expect(
        db.transaction((sql) => sql.query(statement)),
      ).rejects.toThrow();
    await expect(
      pg.query(
        "UPDATE axfluxo_video.resource_versions SET hash=$2 WHERE owner_id=$1",
        [owner, "b".repeat(64)],
      ),
    ).rejects.toThrow("immutable");
    const cascades = await pg.query(
      "SELECT conname FROM pg_constraint WHERE connamespace='axfluxo_video'::regnamespace AND confdeltype='c'",
    );
    expect(cascades.rows).toHaveLength(0);
    const policies = await pg.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='axfluxo_video' AND NOT rowsecurity",
    );
    expect(policies.rows).toHaveLength(0);
  });
  it("rejects cross-owner output and pin references at the foreign-key boundary", async () => {
    const batch = await (await send()).json(),
      jobId = batch.jobs[0].id;
    await expect(
      pg.query(
        "INSERT INTO axfluxo_video.render_outputs(id,owner_id,job_id,library_id,file_id,version_id,hash,frame_count,fps) VALUES ($1,$2,$3,$4,'file','v1',$5,60,60)",
        [randomUUID(), other, jobId, `lib-${other}`, "a".repeat(64)],
      ),
    ).rejects.toThrow();
    await expect(
      pg.query(
        "INSERT INTO axfluxo_video.resource_pins(id,owner_id,job_id,library_id,file_id,version_id,hash,kind) VALUES ($1,$2,$3,$4,'file','v1',$5,'video')",
        [randomUUID(), owner, jobId, `lib-${other}`, "a".repeat(64)],
      ),
    ).rejects.toThrow();
  });
  it("uses explicit CORS, rejects oversized/unknown fields, and emits safe errors", async () => {
    const blocked = await send("/v1/developer/me", {
      origin: "https://evil.example",
    });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.has("access-control-allow-origin")).toBe(false);
    const allowed = await send("/v1/developer/me");
    expect(allowed.headers.get("access-control-allow-origin")).toBe(origin);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    const preflight = await app()(
      new Request("https://api.example/render-batches", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization, content-type, idempotency-key",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(
      (
        await send("/render-batches", {
          body: {
            snapshot: snapshot(),
            signed_url: "https://signed.example?secret=1",
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send("/render-batches", {
          body: { value: "x".repeat(1024 * 1024) },
        })
      ).status,
    ).toBe(413);
  });
  it("retains accepted jobs and outbox across an actual database close/reopen", async () => {
    const key = randomUUID(),
      batch = await (await send("/render-batches", { key })).json();
    await pg.close();
    pg = testEngine(directory);
    expect(await (await send(`/render-batches/${batch.id}`)).json()).toEqual(
      batch,
    );
    expect(await (await send("/render-batches", { key })).json()).toEqual(
      batch,
    );
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});
