import { expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { runWorker } from "../worker/runtime/service";
import { workerTasks } from "../worker/runtime/tasks";
import { mediaProcess } from "../worker/render/process";
import { spawnMedia } from "../worker/runtime/process";
import { cloudConfiguration } from "../storage/config";
import { postgresDatabase } from "../db/postgres";
it("serializes all stages, skips flags, and gives each stage a turn", async () => {
  const stop = new AbortController();
  let active = 0,
    peak = 0;
  const calls: string[] = [];
  const tasks = [
    "upload-safety",
    "verify",
    "render",
    "preview",
    "deletion",
    "notifications",
    "disabled",
  ].map((name) => ({
    name,
    enabled: () => name !== "disabled",
    run: async () => {
      active++;
      peak = Math.max(peak, active);
      calls.push(name);
      await delay(1);
      active--;
    },
  }));
  await runWorker(tasks, stop.signal, {
    pause: async () => {
      stop.abort();
    },
  });
  expect(peak).toBe(1);
  expect(calls).toEqual(tasks.slice(0, -1).map((t) => t.name));
});
it("backs off failures while other work advances, and stops new claims on abort", async () => {
  const stop = new AbortController();
  let now = 0,
    attempts = 0,
    healthy = 0;
  await runWorker(
    [
      {
        name: "bad",
        enabled: () => true,
        run: async () => {
          attempts++;
          throw Error("private");
        },
      },
      {
        name: "healthy",
        enabled: () => true,
        run: async () => {
          healthy++;
        },
      },
    ],
    stop.signal,
    {
      now: () => now,
      pollMs: 1000,
      backoffMs: 2000,
      maxBackoffMs: 4000,
      pause: async () => {
        now += 1000;
        if (now === 7000) stop.abort();
      },
    },
  );
  expect(attempts).toBe(3);
  expect(healthy).toBe(7);
  const run = vi.fn();
  await runWorker([{ name: "none", enabled: () => true, run }], stop.signal);
  expect(run).not.toHaveBeenCalled();
});
it("does not create pools or run units when unified worker/storage is disabled", async () => {
  for (const env of [
    {},
    {
      VIDEO_WORKER_ENABLED: "true",
      VIDEO_RENDER_ENABLED: "true",
      CLOUD_UPLOADS_ENABLED: "true",
    },
  ]) {
    const runtime = await workerTasks(env);
    expect(runtime.tasks).toEqual([]);
    await runtime.close();
  }
  expect(
    cloudConfiguration({
      CLOUD_UPLOADS_ENABLED: "true",
      CLOUD_PREVIEW_ENABLED: "true",
    }).uploadsEnabled(),
  ).toBe(false);
  for (const max of [0, 11, Infinity, 1.5])
    expect(() => postgresDatabase({ max })).toThrow(
      "Invalid database pool maximum",
    );
});
it("imports every main without starting listeners, signal handlers or loops", async () => {
  const term = process.listenerCount("SIGTERM"),
    interrupt = process.listenerCount("SIGINT");
  await Promise.all([
    import("../api/main"),
    import("../worker/render/main"),
    import("../worker/probe/main"),
    import("../worker/derivatives/main"),
    import("../worker/deletion/main"),
    import("../worker/notifications/main"),
    import("../worker/runtime/main"),
  ]);
  expect(process.listenerCount("SIGTERM")).toBe(term);
  expect(process.listenerCount("SIGINT")).toBe(interrupt);
});
it("aborts a real ffmpeg and waits for its child close before returning", async () => {
  const stop = new AbortController();
  const run = mediaProcess(
    "ffmpeg",
    [
      "-re",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=32x32:rate=10",
      "-f",
      "null",
      "-",
    ],
    { signal: stop.signal },
  );
  setTimeout(() => stop.abort(), 60);
  await expect(run).rejects.toThrow("LEASE_LOST");
});
it("kills a TERM-resistant child after a finite grace and removes abort listeners", async () => {
  const stop = new AbortController();
  const child = spawnMedia(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)',
    ],
    { stdio: ["ignore", "pipe", "pipe"], signal: stop.signal },
  );
  await new Promise<void>((resolve) =>
    child.stdout!.once("data", () => resolve()),
  );
  const closed = new Promise<string | null>((resolve) =>
    child.once("close", (_code, signal) => resolve(signal)),
  );
  stop.abort();
  expect(await closed).toBe("SIGKILL");
});

it("SIGTERM stops subsequent claims, waits for the child and closes resources in a real process", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "server/tests/runtime-fixture.ts"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    errors = "";
  child.stderr!.on("data", (b) => {
    errors += b;
  });
  child.stdout!.on("data", (b) => {
    output += b;
    if (output.includes("child-ready") && !output.includes("child-closed"))
      child.kill("SIGTERM");
  });
  const code = await new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  expect(errors).toBe("");
  expect(code).toBe(0);
  expect(output).toContain("child-closed\npool-closed");
  expect(output).not.toContain("unexpected-claim");
}, 10000);

it("settles a final-line parser error after the process has closed", async () => {
  await expect(
    mediaProcess("ffmpeg", ["-version"], {
      line() {
        throw Error("bounded-parser-error");
      },
    }),
  ).rejects.toThrow("bounded-parser-error");
});
