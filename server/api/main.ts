// Standalone Node service. Never imported by src/ or by a Next route.
import { createHttpServer, httpConfiguration } from "./http";
import { isEntrypoint, runService } from "../runtime/lifecycle";
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
import {
  cloudExportRouter,
  exportPolicyFor,
  ticketDownload,
} from "../cloud-export/api";
import { exportApiConfiguration } from "../cloud-export/config";
import { ConfigurationError } from "../runtime/config";
export async function startApi(env = process.env) {
  const config = serverConfig(env);
  const cloud = cloudConfiguration(env);
  const verify = supabaseVerifier(config.issuer, config.audience);
  const db = postgresDatabase({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    ssl: config.tls.ssl,
  });
  const exportApi = exportApiConfiguration(env);
  const exportDb = exportApi.enabled()
    ? postgresDatabase(
        {            connectionString: config.databaseUrl,
            max: 1,
            ssl: config.tls.ssl,
        },
        "axfluxo_export_api",
      )
    : null;
  try {
    const accepting = () => Boolean(cloud.storage) && config.admissionEnabled();
    const cloudExport = cloudExportRouter({
      db: exportDb,
      enabled: exportApi.enabled,
      maxUploadBytes: exportApi.maxUploadBytes,
      maxImageBytes: exportApi.maxImageBytes,
      maxClips: exportApi.maxClips,
      maxFrames: exportApi.maxFrames,
      maxOwnerBytes: exportApi.maxOwnerBytes,
      retentionHours: exportApi.retentionHours,
      ticketSeconds: exportApi.ticketSeconds,
    });
    const handler = createVideoApi({
      ...config,
      admissionEnabled: accepting,
      db,
      outputs:
        env.VIDEO_OUTPUTS_ENABLED === "true"
          ? outputsRouter({
              db,
              storage: cloud.storage,
              deletionEnabled: () => env.VIDEO_DELETE_ACCEPTING === "true",
              pushEnabled: () => env.VIDEO_PUSH_ENABLED === "true",
              vapidPublicKey: env.VIDEO_VAPID_PUBLIC_KEY,
            })
          : undefined,
      cloud: cloudRouter({ db, ...cloud }),
      fnf: fnfRouter({
        db,
        enabled: () => accepting() && env.VIDEO_FNF_ACCEPTING === "true",
        unitsPerFrame: config.unitsPerFrame,
      }),
      projects: projectsRouter({
        db,
        enabled: accepting,
        unitsPerFrame: config.unitsPerFrame,
      }),
      render: renderRouter({
        accessGuard:
          env.VIDEO_OUTPUTS_ENABLED === "true" ? outputAvailable : undefined,
        db,
        storage: cloud.storage,
        enabled: accepting,
        unitsPerFrame: config.unitsPerFrame,
      }),
      verify,
      response: cloudExport,
      public: ticketDownload({ db: exportDb }),
    });
    const transfer = httpConfiguration(env);
    const bridge = createHttpServer(handler, transfer, (incoming) =>
      exportPolicyFor(incoming, transfer, exportApi.maxUploadBytes),
    );
    await new Promise<void>((resolve, reject) => {
      bridge.server.once("error", reject);
      bridge.server.listen(config.port, config.host, () => {
        bridge.server.removeListener("error", reject);
        resolve();
      });
    });
    return {
      server: bridge.server,
      async close() {
        bridge.abort();
        await Promise.all([
          new Promise<void>((resolve) => bridge.server.close(() => resolve())),
          db.close(),
          exportDb?.close(),
        ]);
      },
    };
  } catch {
    await db.close();
    await exportDb?.close().catch(() => undefined);
    throw Error("API startup configuration failed");
  }
}
if (isEntrypoint(import.meta.url, ["api.mjs", "api/main.ts"])) {
  void runService(async () => {
    const api = await startApi();
    return () => api.close();
  }, process.env).catch((error: unknown) => {
    if (error instanceof ConfigurationError)
      process.stderr.write(error.message + "\n");
    process.stderr.write(
      "Video API startup/operation failed. Verify server configuration.\n",
    );
    process.exitCode = 1;
  });
}
