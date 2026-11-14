import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Sql, Row } from "../db/database";
import { requireMembership } from "../api/jobs";
import { ApiError } from "../api/errors";
import { jsonBody } from "../api/app";
import { GoogleDrive, MAX_BYTES } from "./google";
import { secret, sha256 } from "./security";
const base = "/api/integrations/google-drive";
const cookie = "__Host-axfluxo-drive";
type Connection = Row & {
  generation: string;
  refresh_cipher: string | null;
  root_id: string | null;
  queue_id: string | null;
  completed_id: string | null;
  account_id: string | null;
  connected: boolean;
};
const reply = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
export function driveRouter(db: Database, google: GoogleDrive) {
  const vault = google.config.vault;
  const owned = <T>(owner: string, work: (sql: Sql) => Promise<T>) =>
    db.transaction(async (sql) => {
      await requireMembership(sql, owner);
      return work(sql);
    });
  const connection = async (sql: Sql, owner: string, lock = false) =>
    (
      await sql.query<Connection>(
        `SELECT * FROM axfluxo_video.drive_connections WHERE owner_id=$1${lock ? " FOR UPDATE" : ""}`,
        [owner],
      )
    ).rows[0];
  async function access(owner: string) {
    // Serialize refresh with disconnect/reconnect. A committed rotation survives later API failure.
    const result = await owned(owner, async (sql) => {
      const row = await connection(sql, owner, true);
      if (!row?.connected || !row.refresh_cipher)
        return { error: new ApiError(401, "DRIVE_RECONNECT_REQUIRED") };
      try {
        const token = await google.token({
          grant_type: "refresh_token",
          refresh_token: vault.open(row.refresh_cipher, owner + ":refresh"),
        });
        if (token.refresh_token)
          await sql.query(
            "UPDATE axfluxo_video.drive_connections SET refresh_cipher=$2 WHERE owner_id=$1",
            [owner, vault.seal(token.refresh_token, owner + ":refresh")],
          );
        return { token: token.access_token, row };
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.code === "DRIVE_RECONNECT_REQUIRED"
        )
          await sql.query(
            "UPDATE axfluxo_video.drive_connections SET connected=false,refresh_cipher=NULL WHERE owner_id=$1",
            [owner],
          );
        return { error };
      }
    });
    if (result.error) throw result.error;
    if (!result.token || !result.row)
      throw new ApiError(401, "DRIVE_RECONNECT_REQUIRED");
    return { token: result.token, row: result.row };
  }
  async function current(owner: string, generation: string) {
    return owned(owner, async (sql) => {
      const row = await connection(sql, owner);
      if (!row?.connected || row.generation !== generation)
        throw new ApiError(409, "DRIVE_CONNECTION_CHANGED");
      return row;
    });
  }
  async function folders(owner: string, token: string, initial: Connection) {
    let row = initial;
    if (!row.root_id || !row.queue_id || !row.completed_id) {
      const ids = await google.ids(token, 3);
      row = await owned(owner, async (sql) => {
        const c = await connection(sql, owner, true);
        if (!c?.connected || c.generation !== initial.generation)
          throw new ApiError(409, "DRIVE_CONNECTION_CHANGED");
        if (!c.root_id) {
          await sql.query(
            "UPDATE axfluxo_video.drive_connections SET root_id=$2,queue_id=$3,completed_id=$4 WHERE owner_id=$1",
            [owner, ...ids],
          );
          c.root_id = ids[0];
          c.queue_id = ids[1];
          c.completed_id = ids[2];
        }
        return c;
      });
    }
    await google.folder(
      token,
      row.root_id!,
      "AxFluxo",
      undefined,
      owner,
      "root",
    );
    await google.folder(
      token,
      row.queue_id!,
      "01_Queue",
      row.root_id!,
      owner,
      "queue",
    );
    await google.folder(
      token,
      row.completed_id!,
      "02_Completed",
      row.root_id!,
      owner,
      "completed",
    );
    await current(owner, row.generation);
    return row;
  }
  /** Public start/callback only; the normal API handler still verifies Supabase for everything else. */
  async function publicRoute(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname === base + "/prepare" && request.method === "GET") {
      const binding = secret();
      return new Response(null, {
        status: 303,
        headers: {
          location: google.config.frontendUrl + "#drive-binding=" + binding,
          "set-cookie": `${cookie}=${binding}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }
    if (![base + "/start", base + "/callback"].includes(url.pathname))
      return null;
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED");
    const state = url.searchParams.get("state");
    if (
      !state ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      url.searchParams.getAll("state").length !== 1
    )
      throw new ApiError(400, "DRIVE_STATE_INVALID");
    const hash = sha256(state);
    const start = url.pathname === base + "/start";
    const binding = request.headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookie + "="))
      ?.slice(cookie.length + 1);
    if (!binding) throw new ApiError(400, "DRIVE_STATE_INVALID");
    const attempt = await db.transaction(async (sql) => {
      await sql.query("SELECT set_config('axfluxo.drive_state',$1,true)", [
        hash,
      ]);
      const row = (
        await sql.query(
          "SELECT * FROM axfluxo_video.drive_oauth WHERE state_hash=$1 AND NOT used AND expires_at>now() FOR UPDATE",
          [hash],
        )
      ).rows[0];
      if (
        !row ||
        row.binding_hash !== sha256(binding) ||
        (start ? row.started : !row.started)
      )
        throw new ApiError(400, "DRIVE_STATE_INVALID");
      await requireMembership(sql, String(row.owner_id));
      if (start)
        await sql.query(
          "UPDATE axfluxo_video.drive_oauth SET started=true,binding_hash=$2 WHERE state_hash=$1",
          [hash, sha256(binding)],
        );
      else
        await sql.query(
          "UPDATE axfluxo_video.drive_oauth SET used=true WHERE state_hash=$1",
          [hash],
        );
      return row;
    });
    if (start)
      return new Response(null, {
        status: 303,
        headers: {
          location: google.authorize(
            state,
            vault.open(
              String(attempt.verifier_cipher),
              String(attempt.owner_id) + ":pkce",
            ),
          ),
          "set-cookie": `${cookie}=${binding}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    // The attempt is consumed in its own committed transaction, including on denial/failure.
    let code = "DRIVE_CONNECTED";
    try {
      if (url.searchParams.has("error"))
        throw new ApiError(400, "DRIVE_OAUTH_DENIED");
      const authorizationCode = url.searchParams.get("code");
      if (
        !authorizationCode ||
        authorizationCode.length > 4096 ||
        url.searchParams.getAll("code").length !== 1
      )
        throw new ApiError(400, "DRIVE_OAUTH_FAILED");
      const owner = String(attempt.owner_id);
      const token = await google.token({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: google.config.callback,
        code_verifier: vault.open(
          String(attempt.verifier_cipher),
          owner + ":pkce",
        ),
      });
      if (!token.refresh_token)
        throw new ApiError(401, "DRIVE_RECONNECT_REQUIRED");
      const account = await google.account(token.access_token);
      const row = await owned(owner, async (sql) => {
        const c = await connection(sql, owner, true);
        if (!c || c.generation !== attempt.generation)
          throw new ApiError(409, "DRIVE_CONNECTION_CHANGED");
        // Switching Google accounts must not reuse IDs belonging to the old account.
        if (c.account_id && c.account_id !== account)
          throw new ApiError(409, "DRIVE_ACCOUNT_MISMATCH");
        await sql.query(
          "UPDATE axfluxo_video.drive_connections SET refresh_cipher=$2,account_id=$3,connected=true WHERE owner_id=$1",
          [
            owner,
            vault.seal(token.refresh_token!, owner + ":refresh"),
            account,
          ],
        );
        return { ...c, account_id: account, connected: true };
      });
      await folders(owner, token.access_token, row);
    } catch (error) {
      code = error instanceof ApiError ? error.code : "DRIVE_OAUTH_FAILED";
    }
    // Plain text has no script, external resources or reflected OAuth parameters.
    return new Response(
      `${code}\nAxFluxoの画面に戻り、接続状態を再確認してください。`,
      {
        status: code === "DRIVE_CONNECTED" ? 200 : 400,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'none'; frame-ancestors 'none'",
          "set-cookie": `${cookie}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
        },
      },
    );
  }
  async function authenticated(
    request: Request,
    owner: string,
  ): Promise<Response | null> {
    const url = new URL(request.url),
      path = url.pathname;
    if (path !== base && !path.startsWith(base + "/")) return null;
    await owned(owner, async () => undefined);
    if (path === base + "/status" && request.method === "GET") {
      const row = await owned(owner, (sql) => connection(sql, owner));
      return reply({
        connected: row?.connected ?? false,
        folders: row?.connected
          ? {
              rootId: row.root_id,
              queueId: row.queue_id,
              completedId: row.completed_id,
            }
          : null,
      });
    }
    if (path === base + "/connect" && request.method === "POST") {
      const { binding } = z
        .strictObject({ binding: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
        .parse(await jsonBody(request));
      const state = secret(),
        verifier = secret(),
        generation = randomUUID();
      await owned(owner, async (sql) => {
        await sql.query(
          "INSERT INTO axfluxo_video.drive_connections(owner_id,generation) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET generation=$2",
          [owner, generation],
        );
        await sql.query(
          "DELETE FROM axfluxo_video.drive_oauth WHERE owner_id=$1",
          [owner],
        );
        await sql.query(
          "INSERT INTO axfluxo_video.drive_oauth(state_hash,owner_id,generation,verifier_cipher,binding_hash) VALUES($1,$2,$3,$4,$5)",
          [
            sha256(state),
            owner,
            generation,
            vault.seal(verifier, owner + ":pkce"),
            sha256(binding),
          ],
        );
      });
      return reply({
        url: new URL(base + "/start?state=" + state, google.config.callback)
          .href,
      });
    }
    if (path === base + "/disconnect" && request.method === "POST") {
      await owned(owner, async (sql) => {
        await sql.query(
          "UPDATE axfluxo_video.drive_connections SET connected=false,refresh_cipher=NULL,generation=$2 WHERE owner_id=$1",
          [owner, randomUUID()],
        );
        await sql.query(
          "DELETE FROM axfluxo_video.drive_oauth WHERE owner_id=$1",
          [owner],
        );
      });
      return reply({ connected: false });
    }
    if (path === base + "/folders" && request.method === "POST") {
      const { token, row } = await access(owner);
      const c = await folders(owner, token, row);
      return reply({
        rootId: c.root_id,
        queueId: c.queue_id,
        completedId: c.completed_id,
      });
    }
    if (path === base + "/files" && request.method === "POST") {
      const body = z
        .strictObject({
          operationId: z.uuid(),
          base64: z.string().max(Math.ceil(MAX_BYTES / 3) * 4),
        })
        .parse(await jsonBody(request));
      const data = Buffer.from(body.base64, "base64");
      if (data.length > MAX_BYTES || data.toString("base64") !== body.base64)
        throw new ApiError(400, "DRIVE_FILE_INVALID");
      const hash = sha256(data),
        { token, row } = await access(owner),
        c = await folders(owner, token, row);
      const reserved = await owned(
        owner,
        async (sql) =>
          (
            await sql.query(
              "SELECT * FROM axfluxo_video.drive_files WHERE owner_id=$1 AND operation_id=$2",
              [owner, body.operationId],
            )
          ).rows[0],
      );
      const id = reserved
        ? String(reserved.file_id)
        : (await google.ids(token, 1))[0];
      const file = await owned(owner, async (sql) => {
        const active = await connection(sql, owner, true);
        if (!active?.connected || active.generation !== row.generation)
          throw new ApiError(409, "DRIVE_CONNECTION_CHANGED");
        await sql.query(
          "INSERT INTO axfluxo_video.drive_files(owner_id,operation_id,file_id,account_id,size,sha256) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [owner, body.operationId, id, c.account_id, data.length, hash],
        );
        const f = (
          await sql.query(
            "SELECT * FROM axfluxo_video.drive_files WHERE owner_id=$1 AND operation_id=$2",
            [owner, body.operationId],
          )
        ).rows[0];
        if (
          f.sha256 !== hash ||
          Number(f.size) !== data.length ||
          f.account_id !== c.account_id
        )
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT");
        return f;
      });
      if (!file.ready)
        await google.upload(
          token,
          String(file.file_id),
          c.queue_id!,
          data,
          owner,
          hash,
        );
      const downloaded = await google.download(token, String(file.file_id));
      if (downloaded.length !== data.length || sha256(downloaded) !== hash)
        throw new ApiError(502, "DRIVE_INTEGRITY_FAILED");
      await owned(owner, async (sql) => {
        const active = await connection(sql, owner, true);
        if (!active?.connected || active.generation !== row.generation)
          throw new ApiError(409, "DRIVE_CONNECTION_CHANGED");
        await sql.query(
          "UPDATE axfluxo_video.drive_files SET ready=true WHERE owner_id=$1 AND operation_id=$2",
          [owner, body.operationId],
        );
      });
      return reply({
        fileId: file.file_id,
        size: data.length,
        sha256: hash,
        verified: true,
      });
    }
    const match = new RegExp("^" + base + "/files/([A-Za-z0-9_-]+)$").exec(
      path,
    );
    if (match && request.method === "GET") {
      const file = await owned(
        owner,
        async (sql) =>
          (
            await sql.query(
              "SELECT * FROM axfluxo_video.drive_files WHERE owner_id=$1 AND file_id=$2 AND ready",
              [owner, match[1]],
            )
          ).rows[0],
      );
      if (!file) throw new ApiError(404, "NOT_FOUND");
      const { token, row } = await access(owner);
      if (row.account_id !== file.account_id)
        throw new ApiError(409, "DRIVE_ACCOUNT_MISMATCH");
      const data = await google.download(token, match[1]);
      if (data.length !== Number(file.size) || sha256(data) !== file.sha256)
        throw new ApiError(502, "DRIVE_INTEGRITY_FAILED");
      await current(owner, row.generation);
      return reply({
        fileId: file.file_id,
        size: data.length,
        sha256: file.sha256,
        base64: data.toString("base64"),
        verified: true,
      });
    }
    throw new ApiError(404, "NOT_FOUND");
  }
  return {
    public: publicRoute,
    // createVideoApi rejects unconfigured origins before invoking this raw-response hook.
    authenticated: async (request: Request, owner: string) => {
      const response = await authenticated(request, owner);
      if (response) {
        response.headers.set("vary", "Origin");
        const origin = request.headers.get("origin");
        if (origin) response.headers.set("access-control-allow-origin", origin);
      }
      return response;
    },
  };
}
