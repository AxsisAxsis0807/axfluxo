import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { testEngine, type TestEngine } from "./engine";
import { jwtVerifier } from "../api/auth";
import { createVideoApi } from "../api/app";
import { unavailableDeveloperServices } from "../contracts/developer-services";
let engine: TestEngine, keys: Awaited<ReturnType<typeof generateKeyPair>>;
const owner = randomUUID(),
  ordinary = randomUUID(),
  issuer = "https://auth.test/auth/v1";
beforeAll(async () => {
  engine = testEngine(
    join(await mkdtemp(join(tmpdir(), "developer-access-")), "db"),
  );
  await engine.exec(
    await readFile(
      new URL("../db/migrations/001_video_foundation.sql", import.meta.url),
      "utf8",
    ),
  );
  await engine.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true),($2,false)",
    [owner, ordinary],
  );
  keys = await generateKeyPair("ES256");
}, 30000);
afterAll(async () => engine?.close());
async function token(sub: string, overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    role: "authenticated",
    user_metadata: { developer: true },
    ...overrides,
  })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setSubject(sub)
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience("authenticated")
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}
async function request(path: string, bearer?: string) {
  const jwk = await exportJWK(keys.publicKey);
  const api = createVideoApi({
    db: engine.asRole("axfluxo_video_api"),
    verify: jwtVerifier(
      createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "ES256" }] }),
      { issuer, audience: "authenticated" },
    ),
    allowedOrigins: ["https://pages.test"],
    admissionEnabled: () => false,
    developerServices: {
      cloudLibrary: true,
      uploads: true,
      preview: true,
      projects: true,
      fnfPreferences: true,
      outputs: true,
      renderAcceptance: true,
      deleteAcceptance: true,
      push: true,
    },
  });
  return api(
    new Request(`https://api.test${path}`, {
      headers: {
        origin: "https://pages.test",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    }),
  );
}
it("authenticates signatures and membership for both entry and readiness", async () => {
  for (const path of ["/v1/developer/me", "/v1/developer/services"]) {
    expect((await request(path)).status).toBe(401);
    expect((await request(path, await token(ordinary))).status).toBe(403);
    expect((await request(path, await token(randomUUID()))).status).toBe(403);
    expect((await request(path, await token(owner))).status).toBe(200);
  }
});
it("supports auth-only Phase A without pretending the media stack is ready", async () => {
  expect(
    await (await request("/v1/developer/services", await token(owner))).json(),
  ).toEqual(unavailableDeveloperServices);
});
it("rejects revoked, expired and incorrectly signed credentials", async () => {
  const good = await token(owner);
  await engine.query(
    "UPDATE axfluxo_video.developer_memberships SET active=false WHERE owner_id=$1",
    [owner],
  );
  expect((await request("/v1/developer/me", good)).status).toBe(403);
  await engine.query(
    "UPDATE axfluxo_video.developer_memberships SET active=true WHERE owner_id=$1",
    [owner],
  );
  const expired = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setSubject(owner)
    .setIssuer(issuer)
    .setAudience("authenticated")
    .setIssuedAt(1)
    .setExpirationTime(2)
    .sign(keys.privateKey);
  expect((await request("/v1/developer/me", expired)).status).toBe(401);
  const impostor = await generateKeyPair("ES256");
  const forged = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setSubject(owner)
    .setIssuer(issuer)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(impostor.privateKey);
  expect((await request("/v1/developer/services", forged)).status).toBe(401);
});

async function ensureMediaSchema() {
  if (
    (
      await engine.query(
        "SELECT to_regclass('axfluxo_video.media_versions') AS table_name",
      )
    ).rows[0].table_name
  )
    return;
  for (const name of [
    "002_cloud_library.sql",
    "003_video_preview.sql",
    "004_video_render.sql",
    "005_all_versions_projects.sql",
    "006_fnf_preferences.sql",
    "007_video_outputs.sql",
  ])
    await engine.exec(
      await readFile(
        new URL(`../db/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
}
it("keeps media disabled until owner quota/budget and matching migrations exist", async () => {
  await ensureMediaSchema();
  let view = await (
    await request("/v1/developer/services", await token(owner))
  ).json();
  expect(view.cloudLibrary).toBe(true);
  expect(view.uploads).toBe(false);
  expect(view.renderAcceptance).toBe(false);
  await engine.query(
    "INSERT INTO axfluxo_video.media_quotas(owner_id,limit_bytes) VALUES($1,1000000)",
    [owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.usage_budgets(owner_id,limit_units) VALUES($1,1000000)",
    [ordinary],
  );
  view = await (
    await request(
      `/v1/developer/services?owner=${ordinary}`,
      await token(owner),
    )
  ).json();
  expect(view.uploads).toBe(true);
  expect(view.renderAcceptance).toBe(false);
  await engine.query(
    "INSERT INTO axfluxo_video.usage_budgets(owner_id,limit_units) VALUES($1,1000000)",
    [owner],
  );
  view = await (
    await request("/v1/developer/services", await token(owner))
  ).json();
  expect(view.renderAcceptance).toBe(true);
  expect(view.fnfRenderAcceptance).toBe(false);
  await engine.query(
    "UPDATE axfluxo_video.media_quotas SET blocked=true WHERE owner_id=$1",
    [owner],
  );
  view = await (
    await request("/v1/developer/services", await token(owner))
  ).json();
  expect(view.uploads).toBe(false);
  expect(view.renderAcceptance).toBe(false);
});

it("respects configured capacity holds instead of presenting uploads/render as available", async () => {
  await ensureMediaSchema();
  await engine.query(
    "INSERT INTO axfluxo_video.media_quotas(owner_id,limit_bytes) VALUES($1,1000000) ON CONFLICT(owner_id) DO UPDATE SET blocked=false,limit_bytes=1000000",
    [owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.usage_budgets(owner_id,limit_units) VALUES($1,1000000) ON CONFLICT(owner_id) DO UPDATE SET limit_units=1000000",
    [owner],
  );
  await engine.query(
    "UPDATE axfluxo_video.media_quotas SET blocked=false,limit_bytes=1000000 WHERE owner_id=$1",
    [owner],
  );
  vi.stubEnv("VIDEO_OUTPUTS_ENABLED", "true");
  try {
    const response = await request(
      "/v1/developer/services",
      await token(owner),
    );
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.uploads).toBe(false);
    expect(view.renderAcceptance).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});
