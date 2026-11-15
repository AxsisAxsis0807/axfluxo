import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { exportWorkerConfiguration } from "../../cloud-export/config";
import { runExportPass } from "../../cloud-export/worker";
import { postgresDatabase } from "../../db/postgres";
import { production, type Environment } from "../../runtime/config";
import type { WorkerTask } from "./service";

/** Reject aliases and ancestor roots; neither renderer may sweep the other's work. */
export async function separateExportDirectory(
  exportRoot: string,
  renderRoot: string,
) {
  const [a, b] = await Promise.all([
    realpath(exportRoot),
    realpath(renderRoot),
  ]);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return (
      path === "" ||
      (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    );
  };
  if (contains(a, b) || contains(b, a))
    throw Error("Export and render work directories must be separate");
}

/** One existing queue pass, never another worker loop or automatic retention sweep. */
export async function exportTask(env: Environment, renderDirectory?: string) {
  // An operator attestation, NOT a cross-process mutex. Independent DB slots remain.
  if (production(env) && env.EXPORT_UNIFIED_WORKER_CUTOVER_CONFIRMED !== "true")
    throw Error("Unified export requires confirmed worker cutover");
  const config = exportWorkerConfiguration(env);
  await mkdir(config.workDirectory, { recursive: true, mode: 0o700 });
  if (renderDirectory)
    await separateExportDirectory(config.workDirectory, renderDirectory);
  const db = postgresDatabase(
    { connectionString: config.databaseUrl, max: 1, ssl: config.tls.ssl },
    "axfluxo_export_worker",
  );
  const task: WorkerTask = {
    name: "cloud-export",
    enabled: () => env.EXPORT_UNIFIED_WORKER_ENABLED === "true",
    async run(signal) {
      signal.throwIfAborted();
      await runExportPass(db, config, signal);
    },
  };
  return { task, close: () => db.close() };
}
