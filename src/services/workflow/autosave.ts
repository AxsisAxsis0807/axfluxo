import { WORKFLOW_LIMITS } from "../../config/workflow-limits";
import type { WorkflowDocument, Viewport } from "../../domain/workflow/schema";
import { saveWorkflow, WorkflowConflict } from "./repository";
export type SaveStatus =
  "未保存" | "保存中" | "保存済み" | "競合・未保存" | "保存失敗・未保存";
// Generation tracks both graph and viewport edits; CAS revision tracks committed storage only.
export class WorkflowAutosave {
  private generation = 0;
  private saved = -1;
  private timer?: ReturnType<typeof setTimeout>;
  private maximum?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;
  private blocked = false;
  private snapshot?: { document: WorkflowDocument; viewport: Viewport };
  constructor(
    private revision: number | null,
    private notify: (status: SaveStatus, error?: unknown) => void,
    private write = saveWorkflow,
  ) {}
  edit(document: WorkflowDocument, viewport: Viewport) {
    if (this.stopped) return;
    this.snapshot = {
      document: structuredClone(document),
      viewport: { ...viewport },
    };
    this.generation++;
    if (this.blocked) return;
    this.notify("未保存");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), WORKFLOW_LIMITS.debounce);
    this.maximum ??= setTimeout(
      () => void this.flush(),
      WORKFLOW_LIMITS.maxWait,
    );
  }
  async flush() {
    if (
      this.stopped ||
      this.blocked ||
      this.running ||
      !this.snapshot ||
      this.saved === this.generation
    )
      return;
    clearTimeout(this.timer);
    clearTimeout(this.maximum);
    this.maximum = undefined;
    this.running = true;
    const generation = this.generation,
      snapshot = this.snapshot;
    this.notify("保存中");
    try {
      const saved = await this.write(
        snapshot.document,
        snapshot.viewport,
        this.revision,
      );
      this.revision = saved.revision;
      this.saved = generation;
      if (!this.stopped)
        this.notify(this.generation === generation ? "保存済み" : "未保存");
    } catch (e) {
      this.blocked = true;
      if (!this.stopped)
        this.notify(
          e instanceof WorkflowConflict ? "競合・未保存" : "保存失敗・未保存",
          e,
        );
    } finally {
      this.running = false;
      if (!this.stopped && !this.blocked && this.saved !== this.generation)
        void this.flush();
    }
  }
  retry() {
    this.blocked = false;
    void this.flush();
  }
  dispose() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.maximum);
  }
}
