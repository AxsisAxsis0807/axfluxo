import { afterAll, beforeAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
const dev = "11111111-1111-4111-8111-111111111111",
  normal = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    `CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; INSERT INTO auth.users VALUES ('${dev}'),('${normal}');`,
  );
  await db.exec(
    await readFile(
      "supabase/migrations/202611030001_developer_access.sql",
      "utf8",
    ),
  );
  await db.query(
    "INSERT INTO axfluxo_access.developer_memberships(user_id,active) VALUES($1,true)",
    [dev],
  );
});
afterAll(async () => await db?.close());
async function access(role: string, id: string) {
  return db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [id]);
    return (
      await tx.query<{
        access: null | {
          ownerId: string;
          membership: string;
          validUntil: string;
        };
      }>("SELECT public.axfluxo_developer_access() AS access")
    ).rows[0].access;
  });
}
it("only a server-managed active membership grants the caller's identity", async () => {
  const value = await access("authenticated", dev);
  expect(value?.ownerId).toBe(dev);
  expect(value?.membership).toBe("developer");
  expect(Date.parse(value!.validUntil) - Date.now()).toBeLessThanOrEqual(
    60_000,
  );
  expect(await access("authenticated", normal)).toBeNull();
});
it("rejects anonymous callers and prevents membership reads/writes by users", async () => {
  await expect(access("anon", "")).rejects.toThrow(/permission denied/);
  for (const sql of [
    "SELECT * FROM axfluxo_access.developer_memberships",
    `INSERT INTO axfluxo_access.developer_memberships(user_id,active) VALUES('${normal}',true)`,
    `UPDATE axfluxo_access.developer_memberships SET active=true`,
  ]) {
    await expect(
      db.transaction(async (tx) => {
        await tx.exec("SET LOCAL ROLE authenticated");
        await tx.exec(sql);
      }),
    ).rejects.toThrow(/permission denied/);
  }
  await expect(
    db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE authenticated");
      await tx.query("SELECT public.axfluxo_developer_access($1::uuid)", [dev]);
    }),
  ).rejects.toThrow(/does not exist/);
});
it("revocation and expiry apply immediately to later checks", async () => {
  await db.query(
    "UPDATE axfluxo_access.developer_memberships SET active=false WHERE user_id=$1",
    [dev],
  );
  expect(await access("authenticated", dev)).toBeNull();
  await db.query(
    "UPDATE axfluxo_access.developer_memberships SET active=true,expires_at=now()-interval '1 second' WHERE user_id=$1",
    [dev],
  );
  expect(await access("authenticated", dev)).toBeNull();
});
