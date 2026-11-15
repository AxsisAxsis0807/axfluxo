import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const state = vi.hoisted(() => ({
  roles: [] as string[],
  closed: 0,
  passes: 0,
}));
vi.mock("../db/postgres", () => ({
  postgresDatabase: (_config: unknown, role: string) => {
    state.roles.push(role);
    return {
      close: async () => {
        state.closed++;
      },
    };
  },
}));
vi.mock("../cloud-export/worker", () => ({
  runExportPass: async () => {
    state.passes++;
  },
}));
import { workerTasks } from "../worker/runtime/tasks";
import { separateExportDirectory } from "../worker/runtime/export";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  state.roles = [];
  state.closed = 0;
  state.passes = 0;
});
const base = {
  NODE_ENV: "test",
  VIDEO_WORKER_ENABLED: "true",
  EXPORT_UNIFIED_WORKER_ENABLED: "true",
  VIDEO_DATABASE_URL: "postgres://test:test@localhost/axfluxo_video_test",
};
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "unified-config-"));
  dirs.push(dir);
  return dir;
}
it("OFF avoids export DB, credentials and directory initialization, including standalone kinds", async () => {
  for (const env of [
    {},
    { VIDEO_WORKER_ENABLED: "true" },
    { EXPORT_UNIFIED_WORKER_ENABLED: "true" },
  ]) {
    const runtime = await workerTasks({
      ...env,
      EXPORT_WORK_DIR: "relative",
      VIDEO_DATABASE_URL: "bad",
      GOOGLE_DRIVE_ENABLED: "true",
    });
    expect(runtime.tasks).toEqual([]);
    await runtime.close();
  }
  const runtime = await workerTasks(base, "notifications");
  expect(runtime.tasks).toEqual([]);
  await runtime.close();
  expect(state.roles).toEqual([]);
});
it("runs legacy alone without API admission, unused video/Drive/R2 settings or extra pools", async () => {
  const runtime = await workerTasks({
    ...base,
    EXPORT_ENABLED: "false",
    EXPORT_WORK_DIR: await directory(),
    VIDEO_WORKER_POOL_MAX: "bad",
    VIDEO_RENDER_MAX_WORK_BYTES: "bad",
    GOOGLE_DRIVE_ENABLED: "true",
    CLOUD_R2_BUCKET: "unused",
    DRIVE_CLOUD_MONTHLY_YEN: "bad",
  });
  expect(runtime.tasks.map((t) => t.name)).toEqual(["cloud-export"]);
  await runtime.tasks[0].run(new AbortController().signal);
  await runtime.close();
  expect(state.roles).toEqual(["axfluxo_export_worker"]);
  expect(state.closed).toBe(1);
  expect(state.passes).toBe(1);
});
it("refuses unconfirmed production cutover and invalid legacy settings without allocating pools", async () => {
  for (const extra of [
    { NODE_ENV: "production" },
    { EXPORT_WORK_DIR: "relative" },
    { VIDEO_DATABASE_TLS: "verify-full" },
  ])
    await expect(workerTasks({ ...base, ...extra })).rejects.toThrow(
      "Worker configuration failed",
    );
  expect(state.roles).toEqual([]);
});
it("closes legacy pool if a later enabled service fails configuration", async () => {
  await expect(
    workerTasks({
      ...base,
      EXPORT_WORK_DIR: await directory(),
      VIDEO_PUSH_ENABLED: "true",
    }),
  ).rejects.toThrow("Worker configuration failed");
  expect(state.roles).toEqual(["axfluxo_export_worker"]);
  expect(state.closed).toBe(1);
});
it("rejects shared, nested and symlinked roots while accepting siblings", async () => {
  const root = await directory(),
    a = join(root, "export"),
    b = join(root, "render");
  await mkdir(a);
  await mkdir(b);
  await separateExportDirectory(a, b);
  await expect(separateExportDirectory(a, a)).rejects.toThrow(
    "must be separate",
  );
  await expect(separateExportDirectory(root, b)).rejects.toThrow(
    "must be separate",
  );
  await expect(separateExportDirectory(a, root)).rejects.toThrow(
    "must be separate",
  );
  const dotChild = join(a, "..child");
  await mkdir(dotChild);
  await expect(separateExportDirectory(a, dotChild)).rejects.toThrow(
    "must be separate",
  );
  const alias = join(root, "alias");
  await symlink(a, alias);
  await expect(separateExportDirectory(a, alias)).rejects.toThrow(
    "must be separate",
  );
});

it("accepts confirmed legacy production with the existing internal DB TLS policy", async () => {
  const runtime = await workerTasks({
    ...base,
    NODE_ENV: "production",
    EXPORT_UNIFIED_WORKER_CUTOVER_CONFIRMED: "true",
    EXPORT_WORK_DIR: await directory(),
    VIDEO_DATABASE_TLS: "disable",
  });
  expect(runtime.tasks.map((t) => t.name)).toEqual(["cloud-export"]);
  await runtime.close();
  expect(state.roles).toEqual(["axfluxo_export_worker"]);
  expect(state.closed).toBe(1);
});
it("refuses colliding work roots before creating any export pool", async () => {
  const root = await directory();
  await expect(
    workerTasks({
      ...base,
      EXPORT_WORK_DIR: root,
      VIDEO_RENDER_ENABLED: "true",
      VIDEO_RENDER_DISK: root,
      CLOUD_R2_ENDPOINT: "https://r2.example.test",
      CLOUD_R2_BUCKET: "test",
      CLOUD_R2_ACCESS_KEY_ID: "test",
      CLOUD_R2_SECRET_ACCESS_KEY: "test",
    }),
  ).rejects.toThrow("Worker configuration failed");
  expect(state.roles).toEqual([]);
});

it("does not require a render directory when render has no enabled storage", async () => {
  const runtime = await workerTasks({
    ...base,
    EXPORT_WORK_DIR: await directory(),
    VIDEO_RENDER_ENABLED: "true",
  });
  expect(runtime.tasks.map((t) => t.name)).toEqual(["cloud-export"]);
  await runtime.close();
});
