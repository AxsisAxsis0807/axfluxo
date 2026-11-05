import type { LocalEncodeJob } from "./local-encode";
export type ExportState =
  "queued" | "preparing" | "rendering" | "completed" | "failed" | "cancelled";
export type ExportEntry = {
  id: string;
  interrupted?: boolean;
  recoveryAttempts?: number;
  persistedRecipe?: {
    project: import("./recovery-store").StoredProject;
    index: number;
  };
  filename: string;
  state: ExportState;
  progress: number;
  message: string;
  input?: LocalEncodeJob;
  recovery?: LocalEncodeJob["recovery"];
  rest: boolean;
  result?: { blob: Blob; filename: string };
  error?: string;
};
export type ExportRunner = (
  job: LocalEncodeJob,
  signal: AbortSignal,
  rest: boolean,
  update: (progress: number, message: string) => void,
) => Promise<{ blob: Blob; filename: string }>;
const activeStates = new Set<ExportState>(["preparing", "rendering"]);
/** One slot is held through cancellation cleanup. Components never own the runner. */
export class ExportQueue {
  private entries: ExportEntry[] = [];
  private listeners = new Set<() => void>();
  private running: { id: string; control: AbortController } | undefined;
  private snapshot = { entries: this.entries, paused: false };
  constructor(
    private run: ExportRunner,
    readonly maxJobs = 12,
    readonly outputBudget = 512 * 1024 * 1024,
    readonly outputReservation = 0,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  isRunning = () => Boolean(this.running);
  restore(entries: ExportEntry[]) {
    if (this.running || this.entries.length)
      throw Error("キューは既に開始しています。");
    this.entries = entries;
    this.snapshot = { entries: this.entries, paused: true };
    this.publish();
  }

  private publish() {
    this.snapshot = { ...this.snapshot, entries: [...this.entries] };
    this.listeners.forEach((l) => l());
  }
  private change(id: string, patch: Partial<ExportEntry>) {
    this.entries = this.entries.map((j) =>
      j.id === id ? { ...j, ...patch } : j,
    );
    this.publish();
  }
  enqueue(jobs: LocalEncodeJob[], rest: boolean) {
    if (!jobs.length) throw Error("書き出す動画がありません。");
    if (this.entries.length + jobs.length > this.maxJobs)
      throw Error(
        `保持できるジョブは${this.maxJobs}件までです。保存後に不要なジョブを削除してください。`,
      );
    // The draw closure is created by prepare's immutable render snapshot. File/Blob
    // references are retained, never the editor's revocable source object URL.
    const additions = jobs.map((job) => ({
      id: crypto.randomUUID(),
      filename: job.filename,
      state: "queued" as const,
      progress: 0,
      message: "予約待ち",
      rest,
      recovery: job.recovery,
      input: { ...job, pieces: job.pieces.map((p) => ({ ...p })) },
    }));
    this.entries = [...this.entries, ...additions];
    this.publish();
    void this.pump();
  }
  cancel(id: string) {
    const entry = this.entries.find((j) => j.id === id);
    if (!entry || !(entry.state === "queued" || activeStates.has(entry.state)))
      return;
    this.change(id, {
      state: "cancelled",
      message: "キャンセル済み",
      input: undefined,
    });
    if (this.running?.id === id)
      this.running.control.abort(Error("処理を中止しました。"));
    void this.pump();
  }
  retry(id: string) {
    const entry = this.entries.find((j) => j.id === id);
    if (entry?.state !== "failed" || !entry.input || this.running?.id === id)
      return;
    this.change(id, {
      state: "queued",
      progress: 0,
      error: undefined,
      interrupted: false,
      recoveryAttempts: 0,
      message: "再試行待ち",
    });
    void this.pump();
  }
  move(id: string, direction: -1 | 1) {
    const queued = this.entries.filter((j) => j.state === "queued");
    const index = queued.findIndex((j) => j.id === id),
      other = queued[index + direction];
    if (index < 0 || !other) return;
    const a = this.entries.findIndex((j) => j.id === id),
      b = this.entries.indexOf(other);
    [this.entries[a], this.entries[b]] = [this.entries[b], this.entries[a]];
    this.publish();
  }
  remove(id: string) {
    const entry = this.entries.find((j) => j.id === id);
    if (
      !entry ||
      entry.state === "queued" ||
      activeStates.has(entry.state) ||
      this.running?.id === id
    )
      return;
    this.entries = this.entries.filter((j) => j.id !== id);
    this.publish();
  }
  pause(interrupt = false) {
    this.snapshot = { ...this.snapshot, paused: true };
    this.publish();
    if (interrupt)
      this.running?.control.abort(
        Error("画面の中断により停止しました。前面に戻して再試行してください。"),
      );
  }
  resume() {
    this.entries = this.entries.map((entry) =>
      entry.state === "failed" && entry.interrupted && entry.input
        ? {
            ...entry,
            state: "queued" as const,
            interrupted: false,
            progress: 0,
            error: undefined,
          }
        : entry,
    );
    this.snapshot = { ...this.snapshot, paused: false };
    this.publish();
    void this.pump();
  }
  private async pump() {
    if (this.running || this.snapshot.paused) return;
    const retained = this.entries.reduce(
      (n, j) => n + (j.result?.blob.size ?? 0),
      0,
    );
    if (
      retained >= this.outputBudget ||
      (retained > 0 && retained + this.outputReservation > this.outputBudget)
    ) {
      this.pause();
      return;
    }
    const entry = this.entries.find((j) => j.state === "queued");
    if (!entry?.input) return;
    const control = new AbortController();
    this.running = { id: entry.id, control };
    this.change(entry.id, {
      state: "preparing",
      message: "素材を準備しています…",
    });
    try {
      const result = await this.run(
        entry.input,
        control.signal,
        entry.rest,
        (progress, message) => {
          if (!control.signal.aborted)
            this.change(entry.id, {
              state: "rendering",
              progress: Math.max(0, Math.min(1, progress)),
              message,
            });
        },
      );
      control.signal.throwIfAborted();
      this.change(entry.id, {
        state: "completed",
        result,
        filename: result.filename,
        progress: 1,
        message: "完了・保存できます",
        input: undefined,
      });
    } catch (error) {
      if (this.entries.find((j) => j.id === entry.id)?.state !== "cancelled")
        this.change(entry.id, {
          state: "failed",
          interrupted: control.signal.aborted,
          message: "失敗",
          error:
            error instanceof Error ? error.message : "書き出しに失敗しました。",
        });
    } finally {
      this.running = undefined;
      void this.pump();
      this.publish();
    }
  }
}
