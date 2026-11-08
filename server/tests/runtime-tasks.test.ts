import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  calls: [] as string[],
  roles: [] as string[],
  closed: 0,
}));
vi.mock("../db/postgres", () => ({
  postgresDatabase: (_config: unknown, role: string) => {
    state.roles.push(role);
    return {
      transaction: async (work: (sql: unknown) => unknown) =>
        work({
          query: async (text: string) => ({
            rows: text.includes("state='verifying'")
              ? [{ owner_id: "owner", id: "upload" }]
              : text.includes("media_preview_jobs")
                ? [{ owner_id: "owner", version_id: "version" }]
                : text.includes("push_subscriptions")
                  ? [{ owner_id: "owner" }]
                  : [{ owner_id: "owner", id: "upload", state: "completing" }],
          }),
        }),
      close: async () => {
        state.closed++;
      },
    };
  },
}));
vi.mock("../storage/config", () => ({
  cloudConfiguration: () => ({
    storage: { putRender() {}, putDerived() {} },
    previewEnabled: () => true,
  }),
}));
vi.mock("../api/uploads/service", () => ({
  UploadService: class {
    async complete() {
      state.calls.push("safety");
    }
  },
}));
vi.mock("../worker/probe/verify", () => ({
  verifyUpload: async () => {
    state.calls.push("verify");
  },
}));
vi.mock("../worker/derivatives/service", () => ({
  generatePreview: async () => {
    state.calls.push("preview");
  },
}));
vi.mock("../worker/jobs/queue", () => ({
  claim: async () => {
    state.calls.push("claim");
    return {};
  },
}));
vi.mock("../worker/render/service", () => ({
  executeRender: async () => {
    state.calls.push("render");
  },
}));
vi.mock("../worker/deletion/service", () => ({
  deleteOne: async () => {
    state.calls.push("delete");
  },
}));
vi.mock("../worker/deletion/storage", () => ({ deletionStorage: () => ({}) }));
vi.mock("../worker/notifications/service", () => ({
  notifyOneOwner: async () => {
    state.calls.push("notify");
  },
}));
vi.mock("web-push", () => ({ default: { setVapidDetails() {} } }));
import { workerTasks } from "../worker/runtime/tasks";
import { runWorker } from "../worker/runtime/service";
it("connects existing services in order with separate least-privilege pools, then closes every pool", async () => {
  const runtime = await workerTasks({
    VIDEO_WORKER_ENABLED: "true",
    VIDEO_PROBE_ENABLED: "true",
    CLOUD_PREVIEW_ENABLED: "true",
    VIDEO_RENDER_ENABLED: "true",
    VIDEO_DELETE_WORKER_ENABLED: "true",
    VIDEO_PUSH_ENABLED: "true",
    VIDEO_DATABASE_URL: "postgres://test:test@localhost/axfluxo_video_test",
    VIDEO_DELETE_DATABASE_URL:
      "postgres://delete:test@localhost/axfluxo_video_test",
    VIDEO_NOTIFY_DATABASE_URL:
      "postgres://notify:test@localhost/axfluxo_video_test",
    VIDEO_RENDER_DISK: "/tmp",
    VIDEO_RENDER_MAX_WORK_BYTES: "1073741824",
    VIDEO_VAPID_SUBJECT: "mailto:test@example.test",
    VIDEO_VAPID_PUBLIC_KEY: "test",
    VIDEO_VAPID_PRIVATE_KEY: "test",
  });
  const stop = new AbortController();
  await runWorker(runtime.tasks, stop.signal, {
    pause: async () => {
      stop.abort();
    },
  });
  await runtime.close();
  expect(state.calls).toEqual([
    "safety",
    "verify",
    "claim",
    "render",
    "preview",
    "delete",
    "notify",
  ]);
  expect(state.roles).toEqual([
    "axfluxo_video_probe",
    "axfluxo_video_render",
    "axfluxo_video_delete",
    "axfluxo_video_notify",
  ]);
  expect(state.closed).toBe(4);
});
