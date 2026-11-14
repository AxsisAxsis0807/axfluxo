import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testEngine, type TestEngine } from "./engine";
import { createVideoApi } from "../api/app";
import { ApiError } from "../api/errors";
import { driveRouter } from "../google-drive/router";
import { GoogleDrive, MAX_BYTES, scope } from "../google-drive/google";
import {
  challenge,
  driveConfiguration,
  sha256,
  tokenVault,
} from "../google-drive/security";
const base = "/api/integrations/google-drive",
  owner = randomUUID(),
  other = randomUUID(),
  inactive = randomUUID();
const vault = tokenVault(Buffer.alloc(32, 7).toString("base64"));
const config = {
  frontendUrl: "https://editor.example/developer/video/",
  clientId: "dummy-client",
  clientSecret: "dummy-secret",
  callback: "https://api.example" + base + "/callback",
  vault,
};
let pg: TestEngine;
let counter = 0,
  refreshes = 0,
  creates = 0,
  uploads = 0,
  refreshInvalid = false,
  corrupt = false,
  lostCreate = false,
  lostUpload = false;
let apiFailure: { status: number; reason: string } | null = null;
let account = "google-account-1";
let expectedChallenge = "";
type File = {
  id: string;
  mimeType: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  trashed?: boolean;
  data?: Buffer;
  name?: string;
};
const files = new Map<string, File>();
const transport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "oauth2.googleapis.com") {
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("client_secret")).toBe("dummy-secret");
    if (body.get("grant_type") === "authorization_code") {
      if (challenge(body.get("code_verifier") ?? "") !== expectedChallenge)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
    } else {
      refreshes++;
      if (refreshInvalid)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json({
      access_token: "access-private",
      refresh_token: "refresh-private-" + refreshes,
      expires_in: 3600,
      scope,
    });
  }
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer access-private",
  );
  if (apiFailure)
    return Response.json(
      { error: { errors: [{ reason: apiFailure.reason }] } },
      { status: apiFailure.status },
    );
  if (url.pathname.endsWith("/about"))
    return Response.json({ user: { permissionId: account } });
  if (url.pathname.endsWith("/generateIds"))
    return Response.json({
      ids: Array.from(
        { length: Number(url.searchParams.get("count")) },
        () => `drive-${++counter}`,
      ),
    });
  if (url.pathname === "/upload/drive/v3/files") {
    uploads++;
    const body = Buffer.from(init?.body as Uint8Array),
      text = body.toString();
    const start = text.indexOf("\r\n\r\n") + 4,
      end = text.indexOf("\r\n--", start);
    const info = JSON.parse(text.slice(start, end));
    if (files.has(info.id)) return Response.json({}, { status: 409 });
    const dataStart = body.indexOf("\r\n\r\n", end) + 4;
    const dataEnd = body.lastIndexOf("\r\n--");
    files.set(info.id, {
      ...info,
      mimeType: "application/octet-stream",
      data: body.subarray(dataStart, dataEnd),
    });
    if (lostUpload) {
      lostUpload = false;
      throw Error("network");
    }
    return Response.json({ id: info.id });
  }
  if (url.pathname === "/drive/v3/files") {
    creates++;
    const info = JSON.parse(String(init?.body));
    if (files.has(info.id)) return Response.json({}, { status: 409 });
    files.set(info.id, info);
    if (lostCreate) {
      lostCreate = false;
      throw Error("network");
    }
    return Response.json({ id: info.id });
  }
  const id = url.pathname.split("/").at(-1)!;
  const file = files.get(id);
  if (!file) return Response.json({}, { status: 404 });
  if (url.searchParams.get("alt") === "media")
    return new Response(
      new Uint8Array(
        corrupt ? Buffer.from("corrupt") : (file.data ?? Buffer.alloc(0)),
      ),
    );
  return Response.json(file);
};
const google = new GoogleDrive(config, transport);
const db = () => pg.asRole("axfluxo_video_api");
const app = () => {
  const drive = driveRouter(db(), google);
  return createVideoApi({
    db: db(),
    verify: async (auth) => {
      if (!auth || !["owner", "other", "inactive"].includes(auth.slice(7)))
        throw new ApiError(401, "AUTH_REQUIRED");
      return {
        ownerId:
          auth === "Bearer owner"
            ? owner
            : auth === "Bearer other"
              ? other
              : inactive,
      };
    },
    allowedOrigins: ["https://editor.example"],
    admissionEnabled: () => true,
    response: drive.authenticated,
    public: drive.public,
  });
};
const send = (
  path: string,
  method = "GET",
  body?: unknown,
  user = "owner",
  cookie?: string,
) =>
  app()(
    new Request("https://api.example" + base + path, {
      method,
      headers: {
        ...(user ? { authorization: "Bearer " + user } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
async function begin(user = "owner") {
  const prepared = await send("/prepare", "GET", undefined, "");
  const binding = new URL(prepared.headers.get("location")!).hash.slice(
    "#drive-binding=".length,
  );
  const browserCookie = prepared.headers.get("set-cookie")!.split(";")[0];
  const response = await send("/connect", "POST", { binding }, user);
  expect(response.status).toBe(200);
  const { url } = await response.json();
  // A copied start URL cannot authorize another browser's Google account.
  expect((await app()(new Request(url))).status).toBe(400);
  expect(
    (
      await app()(
        new Request(url, {
          headers: { cookie: "__Host-axfluxo-drive=other-browser" },
        }),
      )
    ).status,
  ).toBe(400);
  const start = await app()(
    new Request(url, { headers: { cookie: browserCookie } }),
  );
  expect(start.status).toBe(303);
  const authorization = new URL(start.headers.get("location")!);
  expect(authorization.searchParams.get("scope")).toBe(scope);
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.has("client_secret")).toBe(false);
  expectedChallenge = authorization.searchParams.get("code_challenge")!;
  return {
    state: authorization.searchParams.get("state")!,
    cookie: start.headers.get("set-cookie")!.split(";")[0],
    url,
  };
}
async function connect(user = "owner") {
  const attempt = await begin(user);
  const response = await send(
    "/callback?state=" + attempt.state + "&code=authorization-code",
    "GET",
    undefined,
    "",
    attempt.cookie,
  );
  expect(response.status).toBe(200);
  return attempt;
}
beforeAll(async () => {
  pg = testEngine(await mkdtemp(join(tmpdir(), "axfluxo-drive-")));
  for (const name of ["001_video_foundation.sql", "010_google_drive.sql"])
    await pg.exec(
      await readFile(
        new URL("../db/migrations/" + name, import.meta.url),
        "utf8",
      ),
    );
  await pg.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true),($2,true),($3,false)",
    [owner, other, inactive],
  );
});
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await pg.query("DELETE FROM axfluxo_video.drive_files");
  await pg.query("DELETE FROM axfluxo_video.drive_oauth");
  await pg.query("DELETE FROM axfluxo_video.drive_connections");
  files.clear();
  counter = 0;
  creates = 0;
  uploads = 0;
  refreshes = 0;
  refreshInvalid = false;
  corrupt = false;
  lostCreate = false;
  lostUpload = false;
  apiFailure = null;
  account = "google-account-1";
});
describe("Google Drive Phase 1: mocked Google + real SQL/RLS", () => {
  it("uses the RFC 7636 S256 challenge and handles interrupted downloads", async () => {
    expect(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const broken = new GoogleDrive(
      config,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(Error("network"));
            },
          }),
        ),
    );
    await expect(broken.download("access", "test-id")).rejects.toMatchObject({
      status: 503,
      code: "DRIVE_UNAVAILABLE",
    });
  });
  it("returns CORS headers only after the API origin guard, including preflight", async () => {
    const request = (origin: string, method = "GET") =>
      app()(
        new Request("https://api.example" + base + "/status", {
          method,
          headers: {
            origin,
            authorization: "Bearer owner",
            ...(method === "OPTIONS"
              ? {
                  "access-control-request-method": "POST",
                  "access-control-request-headers":
                    "authorization,content-type,idempotency-key",
                }
              : {}),
          },
        }),
      );
    expect(
      (await request("https://editor.example")).headers.get(
        "access-control-allow-origin",
      ),
    ).toBe("https://editor.example");
    expect((await request("https://evil.example")).status).toBe(403);
    expect((await request("https://editor.example", "OPTIONS")).status).toBe(
      204,
    );
  });
  it("encrypts tokens with randomized authenticated owner/purpose binding", () => {
    const a = vault.seal("refresh-private", owner + ":refresh"),
      b = vault.seal("refresh-private", owner + ":refresh");
    expect(a).not.toBe(b);
    expect(a).not.toContain("refresh-private");
    expect(vault.open(a, owner + ":refresh")).toBe("refresh-private");
    expect(() => vault.open(a, other + ":refresh")).toThrow();
    expect(() => vault.open(a, owner + ":pkce")).toThrow();
    expect(() =>
      vault.open(a.slice(0, -5) + "AAAAA", owner + ":refresh"),
    ).toThrow();
    expect(() =>
      driveConfiguration({ GOOGLE_DRIVE_ENABLED: "true" }),
    ).toThrow();
    expect(driveConfiguration({})).toBeNull();
  });
  it("binds PKCE and cookie, consumes callback once, and stores no plaintext tokens", async () => {
    const attempt = await begin();
    expect(
      (
        await send(
          "/callback?state=" + attempt.state + "&code=x",
          "GET",
          undefined,
          "",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          "/callback?state=" + attempt.state + "&code=x",
          "GET",
          undefined,
          "",
          "__Host-axfluxo-drive=wrong",
        )
      ).status,
    ).toBe(400);
    expect((await app()(new Request(attempt.url))).status).toBe(400);
    expect(
      (
        await send(
          "/callback?state=" + attempt.state + "&code=x",
          "GET",
          undefined,
          "",
          attempt.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await send(
          "/callback?state=" + attempt.state + "&code=x",
          "GET",
          undefined,
          "",
          attempt.cookie,
        )
      ).status,
    ).toBe(400);
    const row = (
      await pg.query(
        "SELECT * FROM axfluxo_video.drive_connections WHERE owner_id=$1",
        [owner],
      )
    ).rows[0];
    expect(row.refresh_cipher).not.toContain("refresh-private");
    expect(vault.open(String(row.refresh_cipher), owner + ":refresh")).toBe(
      "refresh-private-0",
    );
    const status = await (await send("/status")).text();
    expect(status).not.toContain("private");
    expect(creates).toBe(3);
  });
  it("rejects wrong PKCE, expired state, denial, changed generation and replay after failure", async () => {
    let a = await begin();
    expectedChallenge = "wrong";
    expect(
      (
        await send(
          "/callback?state=" + a.state + "&code=x",
          "GET",
          undefined,
          "",
          a.cookie,
        )
      ).status,
    ).toBe(400);
    expectedChallenge = "";
    expect(
      (
        await send(
          "/callback?state=" + a.state + "&code=x",
          "GET",
          undefined,
          "",
          a.cookie,
        )
      ).status,
    ).toBe(400);
    a = await begin();
    await pg.query(
      "UPDATE axfluxo_video.drive_oauth SET expires_at=now()-interval '1 second'",
    );
    expect(
      (
        await send(
          "/callback?state=" + a.state + "&code=x",
          "GET",
          undefined,
          "",
          a.cookie,
        )
      ).status,
    ).toBe(400);
    a = await begin();
    expect(
      (
        await send(
          "/callback?state=" + a.state + "&error=access_denied",
          "GET",
          undefined,
          "",
          a.cookie,
        )
      ).status,
    ).toBe(400);
    a = await begin();
    await send("/disconnect", "POST", {});
    expect(
      (
        await send(
          "/callback?state=" + a.state + "&code=x",
          "GET",
          undefined,
          "",
          a.cookie,
        )
      ).status,
    ).toBe(400);
  });
  it("reuses folder IDs on reconnect, retains renamed resources, rejects moved/trashed folders", async () => {
    await connect();
    const ids = [...files.keys()];
    files.get(ids[1])!.name = "Renamed";
    await connect();
    expect([...files.keys()]).toEqual(ids);
    expect(creates).toBe(3);
    files.get(ids[1])!.parents = ["elsewhere"];
    expect((await (await send("/folders", "POST", {})).json()).error.code).toBe(
      "DRIVE_FOLDER_RECOVERY_REQUIRED",
    );
    files.get(ids[1])!.parents = [ids[0]];
    files.get(ids[2])!.trashed = true;
    expect((await send("/folders", "POST", {})).status).toBe(409);
    expect(files.size).toBe(3);
  });
  it("retries a lost create response without duplicating folders", async () => {
    lostCreate = true;
    const a = await begin();
    expect(
      (
        await send(
          "/callback?state=" + a.state + "&code=x",
          "GET",
          undefined,
          "",
          a.cookie,
        )
      ).status,
    ).toBe(400);
    expect(files.size).toBe(1);
    expect((await send("/folders", "POST", {})).status).toBe(200);
    expect(files.size).toBe(3);
  });
  it("uploads, downloads, verifies SHA-256 and reuses a reserved ID after lost response", async () => {
    await connect();
    const data = Buffer.from("small test\n"),
      body = { operationId: randomUUID(), base64: data.toString("base64") };
    lostUpload = true;
    expect((await send("/files", "POST", body)).status).toBe(503);
    const saved = await (await send("/files", "POST", body)).json();
    expect(saved.sha256).toBe(sha256(data));
    expect(saved.size).toBe(data.length);
    expect(files.size).toBe(4);
    const result = await (await send("/files/" + saved.fileId)).json();
    expect(result.base64).toBe(data.toString("base64"));
    expect(result.verified).toBe(true);
    await send("/files", "POST", body);
    expect(uploads).toBe(2);
    expect(files.size).toBe(4);
    expect(
      (
        await send("/files", "POST", {
          ...body,
          base64: Buffer.from("different").toString("base64"),
        })
      ).status,
    ).toBe(409);
    corrupt = true;
    expect((await send("/files/" + saved.fileId)).status).toBe(502);
  });
  it("separates users with RLS and membership and refuses arbitrary file IDs", async () => {
    expect((await send("/connect", "POST", {}, "")).status).toBe(401);
    expect((await send("/connect", "POST", {}, "inactive")).status).toBe(403);
    await connect();
    const saved = await (
      await send("/files", "POST", {
        operationId: randomUUID(),
        base64: "dGVzdA==",
      })
    ).json();
    expect(
      (await send("/files/" + saved.fileId, "GET", undefined, "other")).status,
    ).toBe(404);
    expect(
      (await (await send("/status", "GET", undefined, "other")).json())
        .connected,
    ).toBe(false);
    await db().transaction(async (sql) => {
      await sql.query("SELECT set_config('axfluxo.owner_id',$1,true)", [other]);
      expect(
        (await sql.query("SELECT * FROM axfluxo_video.drive_connections")).rows,
      ).toHaveLength(0);
      expect(
        (await sql.query("SELECT * FROM axfluxo_video.drive_files")).rows,
      ).toHaveLength(0);
      expect(
        (await sql.query("SELECT * FROM axfluxo_video.drive_oauth")).rows,
      ).toHaveLength(0);
      await expect(
        sql.query(
          "INSERT INTO axfluxo_video.drive_connections(owner_id,generation) VALUES($1,$2)",
          [owner, randomUUID()],
        ),
      ).rejects.toThrow();
    });
  });
  it("persists token rotation and marks invalid_grant as reconnect required", async () => {
    await connect();
    await send("/folders", "POST", {});
    expect(refreshes).toBe(1);
    let row = (await pg.query("SELECT * FROM axfluxo_video.drive_connections"))
      .rows[0];
    expect(vault.open(String(row.refresh_cipher), owner + ":refresh")).toBe(
      "refresh-private-1",
    );
    refreshInvalid = true;
    expect((await send("/folders", "POST", {})).status).toBe(401);
    row = (await pg.query("SELECT * FROM axfluxo_video.drive_connections"))
      .rows[0];
    expect(row.connected).toBe(false);
    expect(row.refresh_cipher).toBeNull();
  });
  it.each([
    [507, 403, "storageQuotaExceeded", "DRIVE_QUOTA_EXCEEDED"],
    [503, 429, "rateLimitExceeded", "DRIVE_RETRY_LATER"],
    [503, 503, "backendError", "DRIVE_RETRY_LATER"],
    [403, 403, "insufficientFilePermissions", "DRIVE_PERMISSION_DENIED"],
    [401, 401, "authError", "DRIVE_RECONNECT_REQUIRED"],
  ])("maps API errors (%s)", async (status, googleStatus, reason, code) => {
    await connect();
    apiFailure = { status: Number(googleStatus), reason: String(reason) };
    const response = await send("/folders", "POST", {});
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
    expect(files.size).toBe(3);
  });
  it("disconnect keeps folders/files, reconnect rejects different Google accounts", async () => {
    await connect();
    await send("/files", "POST", {
      operationId: randomUUID(),
      base64: "dGVzdA==",
    });
    await send("/disconnect", "POST", {});
    expect(files.size).toBe(4);
    expect((await send("/folders", "POST", {})).status).toBe(401);
    account = "different";
    const a = await begin();
    const response = await send(
      "/callback?state=" + a.state + "&code=x",
      "GET",
      undefined,
      "",
      a.cookie,
    );
    expect(await response.text()).toContain("DRIVE_ACCOUNT_MISMATCH");
    expect(files.size).toBe(4);
  });
  it("rejects oversized/invalid base64 and caps streamed downloads", async () => {
    await connect();
    expect(
      (
        await send("/files", "POST", {
          operationId: randomUUID(),
          base64: "***",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send("/files", "POST", {
          operationId: randomUUID(),
          base64: Buffer.alloc(MAX_BYTES + 1).toString("base64"),
        })
      ).status,
    ).toBe(400);
    const saved = await (
      await send("/files", "POST", {
        operationId: randomUUID(),
        base64: "dGVzdA==",
      })
    ).json();
    files.get(saved.fileId)!.data = Buffer.alloc(MAX_BYTES + 1);
    expect((await send("/files/" + saved.fileId)).status).toBe(502);
  });
});
