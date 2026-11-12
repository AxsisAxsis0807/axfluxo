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
import {
  StartupError,
  startupFailureLine,
  type StartupStage,
} from "./startup";

export async function startApi(
  env: Record<string, string | undefined> = process.env,
) {
  let stage: StartupStage = "config";
  let cleanup: (() => Promise<void>) | undefined;
  let bridge: ReturnType<typeof createHttpServer> | undefined;
  try {
    const config = serverConfig(env);
    stage = "storage";
    const cloud = cloudConfiguration(env);
    stage = "jwt";
    const verify = supabaseVerifier(config.issuer, config.audience);
    stage = "database";
    const db = postgresDatabase({
      connectionString: config.databaseUrl,
      max: config.poolMax,
      ssl: config.tls.ssl,
    });
    stage = "export";
    const exportApi = exportApiConfiguration(env);
    const exportDb = exportApi.enabled()
      ? postgresDatabase(
          {
            connectionString: config.databaseUrl,
            max: 1,
            ssl: config.tls.ssl,
          },
          "axfluxo_export_api",
        )
      : null;
    cleanup = async () => {
      await db.close().catch(() => undefined);
      await exportDb?.close().catch(() => undefined);
    };
    stage = "router";
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
    stage = "http";
    const transfer = httpConfiguration(env);
    const server = createHttpServer(handler, transfer, (incoming) =>
      exportPolicyFor(incoming, transfer, exportApi.maxUploadBytes),
    );
    bridge = server;
    stage = "listen";
    await new Promise<void>((resolve, reject) => {
      server.server.once("error", reject);
      server.server.listen(config.port, config.host, () => {
        server.server.removeListener("error", reject);
        resolve();
      });
    });
    return {
      server: server.server,
      async close() {
        server.abort();
        await Promise.all([
          new Promise<void>((resolve) => server.server.close(() => resolve())),
          db.close(),
          exportDb?.close(),
        ]);
      },
    };
  } catch (error) {
    bridge?.abort();
    await cleanup?.();
    throw new StartupError(stage, error);
  }
}
if (isEntrypoint(import.meta.url, ["api.mjs", "api/main.ts"])) {
  void runService(async () => {
    const api = await startApi();
    return () => api.close();
  }, process.env).catch((error: unknown) => {
    // Stage and whitelisted reason only: never a setting value or connection string.
    if (error instanceof StartupError || error instanceof ConfigurationError)
      process.stderr.write(startupFailureLine(error) + "\n");
    process.stderr.write(
      "Video API startup/operation failed. Verify server configuration.\n",
    );
    process.exitCode = 1;
  });
}
