import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { FakeStorage } from "./cloud/fake-storage";
import { storeObject } from "../worker/render/objects";
import type { Claim } from "../worker/jobs/queue";
import { testEngine, type TestEngine } from "./engine";
import { createVideoApi } from "../api/app";
import { outputsRouter, outputAvailable } from "../api/outputs/router";
import { deleteOne } from "../worker/deletion/service";
import { notifyOneOwner } from "../worker/notifications/service";
import { requireMembership, capacityGuard } from "../api/jobs";
import { ApiError } from "../api/errors";
let engine: TestEngine,
  owner: string,
  id: string,
  object: string,
  job: string,
  batch: string,
  version: string;
const hash = "a".repeat(64);
let deletion = true;
const db = () => engine.asRole("axfluxo_video_api");
function request(
  path: string,
  body?: unknown,
  auth: string | null = owner,
  key = randomUUID(),
) {
  const app = createVideoApi({
    db: db(),
    verify: async (a) => {
      if (!a) throw new ApiError(401, "UNAUTHENTICATED");
      return { ownerId: a };
    },
    allowedOrigins: ["https://editor.test"],
    admissionEnabled: () => true,
    outputs: outputsRouter({
      db: db(),
      storage: null,
      deletionEnabled: () => deletion,
      pushEnabled: () => true,
      vapidPublicKey: "test",
    }),
  });
  return app(
    new Request(`https://api.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(auth ? { authorization: auth } : {}),
        "content-type": "application/json",
        "idempotency-key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
const confirmation = () => ({
  versionId: version,
  hash,
  photoLibraryChecked: true,
});
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "axfluxo-v7-"));
  engine = testEngine(join(dir, "db"));
  for (const name of (
    await readdir(new URL("../db/migrations/", import.meta.url))
  )
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await engine.exec(
      await readFile(
        new URL(`../db/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
}, 60000);
afterAll(async () => engine?.close());
async function seed(namespace = "outputs-v1") {
  await engine.query(
    "UPDATE axfluxo_video.output_deletions SET state='held',reason='LEGACY_STORAGE_RETAINED' WHERE state<>'deleted'",
  );
  owner = randomUUID();
  id = randomUUID();
  object = randomUUID();
  job = randomUUID();
  batch = randomUUID();
  version = randomUUID();
  deletion = true;
  await engine.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true)",
    [owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.media_quotas(owner_id,limit_bytes,used_bytes) VALUES($1,1000,20)",
    [owner],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.render_batches(id,owner_id,snapshot,snapshot_hash) VALUES($1,$2,'{}',$3)",
    [batch, owner, hash],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.render_jobs(id,owner_id,batch_id,range_index,attempt,state) VALUES($1,$2,$3,0,1,'running')",
    [job, owner, batch],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.render_executions(owner_id,job_id,token) VALUES($1,$2,42)",
    [owner, job],
  );
  await engine.query(
    "UPDATE axfluxo_video.render_slot SET owner_id=$1,job_id=$2,token=42,lease_until=now()+interval '1 hour' WHERE id=1",
    [owner, job],
  );
  await engine.query("SELECT set_config('axfluxo.render_token','42',false)");
  await engine.query(
    "INSERT INTO axfluxo_video.resource_versions(owner_id,library_id,file_id,version_id,hash,kind) VALUES($1,'render',$2,$3,$4,'video')",
    [owner, id, version, hash],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.render_outputs(id,owner_id,job_id,library_id,file_id,version_id,hash,frame_count,fps,created_at) VALUES($1::uuid,$2,$3,'render',$1::text,$4,$5,60,60,now()-interval '31 days')",
    [id, owner, job, version, hash],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.render_objects(id,owner_id,job_id,object_key,hash,size,kind,plan_hash,ready,storage_namespace) VALUES($1,$2,$3,$4,$5,20,'output',$5,true,$6)",
    [
      object,
      owner,
      job,
      `render-outputs/${owner}/${job}/${object}.mp4`,
      hash,
      namespace,
    ],
  );
  await engine.query(
    "INSERT INTO axfluxo_video.render_artifacts(owner_id,output_id,object_id,validation) VALUES($1,$2,$3,'{}')",
    [owner, id, object],
  );
  await engine.query(
    "UPDATE axfluxo_video.render_jobs SET state='succeeded' WHERE id=$1",
    [job],
  );
}
beforeEach(() => seed());

it("requires authentication, active membership, owner and exact output identity", async () => {
  expect((await request("/outputs", undefined, null)).status).toBe(401);
  expect((await request("/outputs", undefined, randomUUID())).status).toBe(403);
  const other = randomUUID();
  await engine.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true)",
    [other],
  );
  expect(
    (await request(`/outputs/${id}/confirm-saved`, confirmation(), other))
      .status,
  ).toBe(404);
  expect(
    (
      await request(`/outputs/${id}/confirm-saved`, {
        ...confirmation(),
        hash: "b".repeat(64),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(`/outputs/${id}/confirm-saved`, {
        ...confirmation(),
        photoLibraryChecked: false,
      })
    ).status,
  ).toBe(400);
  await engine.query(
    "UPDATE axfluxo_video.developer_memberships SET active=false WHERE owner_id=$1",
    [owner],
  );
  expect((await request("/outputs")).status).toBe(403);
});
it("warns after30 days and never deletes unconfirmed outputs; confirmation is idempotent", async () => {
  const page = await (await request("/outputs")).json();
  expect(page.items[0].unconfirmed30Days).toBe(true);
  const erase = vi.fn();
  await deleteOne(engine.asRole("axfluxo_video_delete"), { erase }, () => true);
  expect(erase).not.toHaveBeenCalled();
  const key = randomUUID();
  expect(
    (await request(`/outputs/${id}/confirm-saved`, confirmation(), owner, key))
      .status,
  ).toBe(202);
  expect(
    (await request(`/outputs/${id}/confirm-saved`, confirmation(), owner, key))
      .status,
  ).toBe(202);
  expect(
    (
      await request(
        `/outputs/${id}/confirm-saved`,
        { ...confirmation(), versionId: "other" },
        owner,
        key,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.output_deletions WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(1);
});
it("recovers a failure after object deletion and charges quota once; refuses new references", async () => {
  await request(`/outputs/${id}/confirm-saved`, confirmation());
  let exists = true;
  const erase = vi.fn(async () => {
    if (exists) {
      exists = false;
      throw Error("lost response");
    }
  });
  await expect(
    deleteOne(engine.asRole("axfluxo_video_delete"), { erase }, () => true),
  ).rejects.toThrow("lost response");
  await expect(
    db().transaction(async (sql) => {
      await requireMembership(sql, owner);
      await outputAvailable(sql, owner, id);
    }),
  ).rejects.toMatchObject({ status: 410 });
  await expect(
    db().transaction(async (sql) => {
      await requireMembership(sql, owner);
      await sql.query(
        "INSERT INTO axfluxo_video.video_projects(owner_id,id,revision,project) VALUES($1,$2,1,$3::jsonb)",
        [owner, randomUUID(), JSON.stringify({ versionId: version })],
      );
    }),
  ).rejects.toThrow();
  await engine.query(
    "UPDATE axfluxo_video.output_deletions SET next_at=now() WHERE owner_id=$1",
    [owner],
  );
  expect(
    await deleteOne(
      engine.asRole("axfluxo_video_delete"),
      { erase },
      () => true,
    ),
  ).toBe(true);
  await deleteOne(engine.asRole("axfluxo_video_delete"), { erase }, () => true);
  expect(
    Number(
      (
        await engine.query(
          "SELECT used_bytes FROM axfluxo_video.media_quotas WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].used_bytes,
    ),
  ).toBe(0);
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.resource_versions WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(1);
});
it("retains pinned output and legacy objects; disabled workers do nothing", async () => {
  await engine.query(
    "INSERT INTO axfluxo_video.video_projects(owner_id,id,revision,project) VALUES($1,$2,1,$3::jsonb)",
    [owner, randomUUID(), JSON.stringify({ versionId: version })],
  );
  await request(`/outputs/${id}/confirm-saved`, confirmation());
  const erase = vi.fn();
  await deleteOne(engine.asRole("axfluxo_video_delete"), { erase }, () => true);
  expect(erase).not.toHaveBeenCalled();
  expect(
    (
      await engine.query(
        "SELECT reason FROM axfluxo_video.output_deletions WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].reason,
  ).toBe("RESOURCE_PINNED");
  expect(
    await deleteOne(
      engine.asRole("axfluxo_video_delete"),
      { erase },
      () => false,
    ),
  ).toBe(false);
  deletion = false;
  expect(
    (await request(`/outputs/${id}/confirm-saved`, confirmation())).status,
  ).toBe(503);
});
it("push410 expires subscriptions without changing outputs; duplicate completion sends once", async () => {
  const sid = randomUUID();
  await engine.query(
    "INSERT INTO axfluxo_video.push_subscriptions(id,owner_id,endpoint_hash,subscription) VALUES($1,$2,$3,$4::jsonb)",
    [
      sid,
      owner,
      randomUUID(),
      JSON.stringify({
        endpoint: "https://web.push.apple.com/test",
        keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
      }),
    ],
  );
  const send = vi.fn(async () => {
    throw { statusCode: 410 };
  });
  await notifyOneOwner(
    engine.asRole("axfluxo_video_notify"),
    owner,
    send,
    () => true,
  );
  await notifyOneOwner(
    engine.asRole("axfluxo_video_notify"),
    owner,
    send,
    () => true,
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    (
      await engine.query(
        "SELECT active FROM axfluxo_video.push_subscriptions WHERE id=$1",
        [sid],
      )
    ).rows[0].active,
  ).toBe(false);
  expect(
    (
      await engine.query(
        "SELECT id FROM axfluxo_video.render_outputs WHERE id=$1",
        [id],
      )
    ).rows,
  ).toHaveLength(1);
});
it("holds admission under capacity pressure", async () => {
  vi.stubEnv("VIDEO_CAPACITY_GUARD_ENABLED", "true");
  vi.stubEnv("VIDEO_CAPACITY_MIN_FREE_BYTES", "2000");
  try {
    await expect(
      db().transaction(async (sql) => {
        await requireMembership(sql, owner);
        await capacityGuard(sql, owner);
      }),
    ).rejects.toMatchObject({ code: "CAPACITY_HELD" });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("holds legacy-bucket originals and preserves confirmation atomically on a transaction fault", async () => {
  await seed("legacy");
  const response = await request(
    `/outputs/${id}/confirm-saved`,
    confirmation(),
  );
  expect(response.status).toBe(202);
  expect((await response.json()).state).toBe("held");
  const erase = vi.fn();
  await deleteOne(engine.asRole("axfluxo_video_delete"), { erase }, () => true);
  expect(erase).not.toHaveBeenCalled();
  await seed();
  const broken = outputsRouter({
    storage: null,
    deletionEnabled: () => true,
    pushEnabled: () => false,
    db: {
      transaction: (work) =>
        db().transaction((sql) =>
          work({
            query: async (text, values) => {
              const result = await sql.query(text, values);
              if (text.startsWith("INSERT INTO axfluxo_video.output_deletions"))
                throw Error("injected transaction failure");
              return result as never;
            },
          }),
        ),
    },
  });
  await expect(
    broken(
      new Request(`https://api.test/outputs/${id}/confirm-saved`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify(confirmation()),
      }),
      owner,
    ),
  ).rejects.toThrow("injected transaction failure");
  expect(
    (
      await engine.query(
        "SELECT * FROM axfluxo_video.output_deletions WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(0);
});
it("scopes private tables and forbids the deletion role from removing originals or output records", async () => {
  const other = randomUUID();
  const rows = await db().transaction(async (sql) => {
    await requireMembership(sql, owner);
    return sql.query(
      "SELECT * FROM axfluxo_video.output_deletions WHERE owner_id=$1",
      [other],
    );
  });
  expect(rows.rows).toHaveLength(0);
  await expect(
    engine.asRole("axfluxo_video_delete").transaction(async (sql) => {
      await requireMembership(sql, owner);
      await sql.query(
        "DELETE FROM axfluxo_video.media_versions WHERE owner_id=$1",
        [owner],
      );
    }),
  ).rejects.toThrow();
  await expect(
    engine.asRole("axfluxo_video_delete").transaction(async (sql) => {
      await requireMembership(sql, owner);
      await sql.query(
        "DELETE FROM axfluxo_video.render_outputs WHERE owner_id=$1",
        [owner],
      );
    }),
  ).rejects.toThrow();
  await engine.query(
    "UPDATE axfluxo_video.developer_memberships SET expires_at=now()-interval '1 second' WHERE owner_id=$1",
    [owner],
  );
  expect((await request("/outputs")).status).toBe(403);
});
it("serializes duplicate deletion and settles one durable quota transition", async () => {
  await request(`/outputs/${id}/confirm-saved`, confirmation());
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const erase = vi.fn(async () => {
    started();
    await barrier;
  });
  const first = deleteOne(
    engine.asRole("axfluxo_video_delete"),
    { erase },
    () => true,
  );
  await waiting;
  expect(
    await deleteOne(
      engine.asRole("axfluxo_video_delete"),
      { erase },
      () => true,
    ),
  ).toBe(false);
  release();
  await first;
  expect(erase).toHaveBeenCalledTimes(1);
});
it("retries a transient push failure using its durable ledger, then deduplicates success", async () => {
  await engine.query(
    "INSERT INTO axfluxo_video.push_subscriptions(id,owner_id,endpoint_hash,subscription) VALUES($1,$2,$3,$4::jsonb)",
    [
      randomUUID(),
      owner,
      randomUUID(),
      JSON.stringify({
        endpoint: "https://web.push.apple.com/test",
        keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
      }),
    ],
  );
  const send = vi
    .fn()
    .mockRejectedValueOnce({ statusCode: 503 })
    .mockResolvedValue(undefined);
  await notifyOneOwner(
    engine.asRole("axfluxo_video_notify"),
    owner,
    send,
    () => true,
  );
  await notifyOneOwner(
    engine.asRole("axfluxo_video_notify"),
    owner,
    send,
    () => true,
  );
  expect(send).toHaveBeenCalledTimes(1);
  await engine.query(
    "UPDATE axfluxo_video.notification_deliveries SET next_at=now() WHERE owner_id=$1",
    [owner],
  );
  await notifyOneOwner(
    engine.asRole("axfluxo_video_notify"),
    owner,
    send,
    () => true,
  );
  await notifyOneOwner(
    engine.asRole("axfluxo_video_notify"),
    owner,
    send,
    () => true,
  );
  expect(send).toHaveBeenCalledTimes(2);
  expect(
    (
      await engine.query(
        "SELECT state FROM axfluxo_video.render_jobs WHERE id=$1",
        [job],
      )
    ).rows[0].state,
  ).toBe("succeeded");
});

it("verifies newly rendered objects in the output namespace and leaves originals untouched", async () => {
  await engine.query(
    "UPDATE axfluxo_video.render_jobs SET state='running' WHERE id=$1",
    [job],
  );
  const original = new FakeStorage(),
    outputs = new FakeStorage();
  original.objects.set("originals/source", new Uint8Array([9]));
  const storage = Object.assign(original, {
    renderNamespace: "outputs-v1",
    forRenderObject: (namespace: string) =>
      namespace === "outputs-v1" ? outputs : original,
    putRender: async (key: string, path: string) => {
      outputs.objects.set(key, await readFile(path));
    },
  });
  const path = join(
    await mkdtemp(join(tmpdir(), "v7-object-")),
    "candidate.mp4",
  );
  await writeFile(path, new Uint8Array([1, 2, 3]));
  const c = {
    owner,
    job,
    batch,
    token: "42",
    runs: 1,
    rangeIndex: 0,
    mode: "fnf",
    snapshot: {},
  } as Claim;
  const result = await storeObject(
    engine.asRole("axfluxo_video_render"),
    storage,
    c,
    {
      path,
      hash: createHash("sha256")
        .update(new Uint8Array([1, 2, 3]))
        .digest("hex"),
      size: 3,
      kind: "candidate",
      planHash: hash,
    },
  );
  expect(result.storage_namespace).toBe("outputs-v1");
  expect(outputs.objects.size).toBe(1);
  expect(original.objects.size).toBe(1);
  expect(original.objects.get("originals/source")).toEqual(new Uint8Array([9]));
});

it("binds push endpoints to one owner and unsubscribes idempotently", async () => {
  const subscription = {
    endpoint: "https://web.push.apple.com/" + randomUUID(),
    keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
  };
  expect((await request("/push/subscribe", subscription)).status).toBe(200);
  expect((await request("/push/subscribe", subscription)).status).toBe(200);
  const other = randomUUID();
  await engine.query(
    "INSERT INTO axfluxo_video.developer_memberships(owner_id,active) VALUES($1,true)",
    [other],
  );
  expect((await request("/push/subscribe", subscription, other)).status).toBe(
    409,
  );
  expect(
    (
      await request(
        "/push/unsubscribe",
        { endpoint: subscription.endpoint },
        other,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await engine.query(
        "SELECT active FROM axfluxo_video.push_subscriptions WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].active,
  ).toBe(true);
  expect(
    (await request("/push/unsubscribe", { endpoint: subscription.endpoint }))
      .status,
  ).toBe(200);
  expect(
    (await request("/push/unsubscribe", { endpoint: subscription.endpoint }))
      .status,
  ).toBe(200);
});
