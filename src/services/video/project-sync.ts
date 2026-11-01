import type { AllVersionsProject } from "../../domain/video/all-versions";
import {
  saveProject,
  localProject,
  syncEntry,
  acknowledge,
  type LocalProject,
} from "../developer-storage/projects";
export type ProjectTransport = {
  put: (
    project: AllVersionsProject,
    revision: number,
  ) => Promise<{ revision: number } | { conflict: AllVersionsProject }>;
};
/** Each editor owns its CAS revision. Never rebase silently over another tab. */
export class ProjectSaveQueue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: AllVersionsProject | undefined;
  private serial: Promise<void> = Promise.resolve();
  private failure: unknown;
  private inFlight = 0;
  private sequence = 0;
  get isSaved() {
    return !this.pending && !this.inFlight && !this.failure;
  }
  revision: number;
  onState?: (state: string) => void;
  constructor(
    readonly owner: string,
    revision = 0,
  ) {
    this.revision = revision;
  }
  schedule(project: AllVersionsProject) {
    this.sequence++;
    this.pending = structuredClone(project);
    this.onState?.("local-dirty");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 750);
  }
  async flush() {
    clearTimeout(this.timer);
    const next = this.pending,
      sequence = this.sequence;
    this.pending = undefined;
    if (next) {
      this.inFlight++;
      this.serial = this.serial
        .then(async () => {
          const row = await saveProject(this.owner, next, this.revision);
          this.revision = row.revision;
          this.failure = undefined;
          this.onState?.(
            this.pending || this.inFlight > 1 ? "local-dirty" : "local-saved",
          );
        })
        .catch((e) => {
          this.failure = e;
          if (sequence === this.sequence) this.pending ??= next;
          this.onState?.("local-error");
        })
        .finally(() => {
          this.inFlight--;
        });
    }
    await this.serial;
    if (this.failure) throw this.failure;
  }
  dispose() {
    clearTimeout(this.timer);
  }
}
const syncing = new Map<string, Promise<void>>();
export function syncProject(
  owner: string,
  id: string,
  transport: ProjectTransport,
) {
  const k = `${owner}:${id}`;
  if (syncing.has(k)) return syncing.get(k)!;
  const run = (async () => {
    const row = await localProject(owner, id);
    if (row?.conflict) throw new Error("PROJECT_CONFLICT");
    const entry = await syncEntry(owner, id);
    if (!entry) return;
    const result = await transport.put(entry.project, entry.expected);
    if ("conflict" in result) {
      await acknowledge(
        owner,
        id,
        entry.revision,
        entry.expected,
        result.conflict,
      );
      throw new Error("PROJECT_CONFLICT");
    }
    await acknowledge(owner, id, entry.revision, result.revision);
  })().finally(() => syncing.delete(k));
  syncing.set(k, run);
  return run;
}
export type { LocalProject };
