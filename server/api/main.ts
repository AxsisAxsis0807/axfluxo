// Standalone Node service. Never imported by src/ or by a Next route.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { postgresDatabase } from "../db/postgres";
import { createVideoApi } from "./app";
import { supabaseVerifier } from "./auth";
import { cloudRouter } from "./assets/router";
import { cloudConfiguration } from "../storage/config";
import { fnfRouter } from "./preferences/router";
import { projectsRouter } from "./projects/router";
import { renderRouter } from "./render";
import { outputsRouter, outputAvailable } from "./outputs/router";
import { serverConfig } from "./config";
function start() {
  const config = serverConfig(process.env);
  const db = postgresDatabase({
    connectionString: config.databaseUrl,
    ssl: config.production ? { rejectUnauthorized: true } : undefined,
  });
  const cloud = cloudConfiguration(process.env);
  const handler = createVideoApi({
    ...config,
    developerServices: {
      cloudLibrary: Boolean(cloud.storage),
      uploads: cloud.uploadsEnabled(),
      preview: cloud.previewEnabled(),
      projects: true,
      fnfPreferences: true,
      outputs: process.env.VIDEO_OUTPUTS_ENABLED === "true",
      renderAcceptance:
        config.admissionEnabled() && config.unitsPerFrame !== undefined,
      fnfRenderAcceptance:
        config.admissionEnabled() &&
        config.unitsPerFrame !== undefined &&
        process.env.VIDEO_FNF_ACCEPTING === "true",
      deleteAcceptance: process.env.VIDEO_DELETE_ACCEPTING === "true",
      push:
        process.env.VIDEO_PUSH_ENABLED === "true" &&
        Boolean(process.env.VIDEO_VAPID_PUBLIC_KEY),
    },
    db,
    outputs:
      process.env.VIDEO_OUTPUTS_ENABLED === "true"
        ? outputsRouter({
            db,
            storage: cloud.storage,
            deletionEnabled: () =>
              process.env.VIDEO_DELETE_ACCEPTING === "true",
            pushEnabled: () => process.env.VIDEO_PUSH_ENABLED === "true",
            vapidPublicKey: process.env.VIDEO_VAPID_PUBLIC_KEY,
          })
        : undefined,
    cloud: cloudRouter({ db, ...cloud }),
    fnf: fnfRouter({
      db,
      enabled: () =>
        config.admissionEnabled() && process.env.VIDEO_FNF_ACCEPTING === "true",
      unitsPerFrame: config.unitsPerFrame,
    }),
    projects: projectsRouter({
      db,
      enabled: config.admissionEnabled,
      unitsPerFrame: config.unitsPerFrame,
    }),
    render: renderRouter({
      accessGuard:
        process.env.VIDEO_OUTPUTS_ENABLED === "true"
          ? outputAvailable
          : undefined,
      db,
      storage: cloud.storage,
      enabled: config.admissionEnabled,
      unitsPerFrame: config.unitsPerFrame,
    }),
    verify: supabaseVerifier(config.issuer, config.audience),
  });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const controller = new AbortController();
      incoming.once("aborted", () => controller.abort());
      const init: RequestInit & { duplex?: "half" } = {
        method: incoming.method,
        headers,
        signal: controller.signal,
      };
      if (!["GET", "HEAD"].includes(incoming.method ?? "GET")) {
        init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        init.duplex = "half";
      }
      const response = await handler(
        new Request(`http://video-api.invalid${incoming.url}`, init),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } catch {
      outgoing.writeHead(500, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      outgoing.end('{"error":{"code":"INTERNAL_ERROR"}}');
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(config.port, "127.0.0.1");
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      server.close(() => {
        void db.close();
      });
    });
}
try {
  start();
} catch {
  process.stderr.write(
    "Video API startup failed. Verify server configuration.\n",
  );
  process.exitCode = 1;
}
