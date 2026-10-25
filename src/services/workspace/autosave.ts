import { WorkspaceConflict } from "./repository";
export type Status =
  "未保存" | "保存中" | "保存済み" | "保存失敗・未保存" | "競合・未保存";
/** Shared by graph/draft: one write at a time and a real, awaitable save barrier. */
export class Autosave<T, R extends { revision: number }> {
  private generation = 0;
  private saved = 0;
  private value?: T;
  private timer?: ReturnType<typeof setTimeout>;
  private maximum?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private error?: unknown;
  private stopped = false;
  constructor(
    public revision: number,
    private write: (value: T, expected: number) => Promise<R>,
    private notify: (status: Status, error?: unknown, saved?: R) => void,
  ) {}
  edit(value: T) {
    this.value = structuredClone(value);
    this.generation++;
    if (this.stopped || this.error) return;
    this.notify("未保存");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 750);
    this.maximum ??= setTimeout(() => {
      void this.flush().catch(() => {});
    }, 5000);
  }
  async flush(): Promise<void> {
    if (this.error) throw this.error;
    if (this.running) {
      await this.running;
      return this.flush();
    }
    if (
      this.stopped ||
      this.value === undefined ||
      this.saved === this.generation
    )
      return;
    clearTimeout(this.timer);
    clearTimeout(this.maximum);
    this.maximum = undefined;
    const generation = this.generation,
      value = this.value;
    this.notify("保存中");
    this.running = (async () => {
      try {
        const result = await this.write(value, this.revision);
        this.revision = result.revision;
        this.saved = generation;
        this.notify(
          this.saved === this.generation ? "保存済み" : "未保存",
          undefined,
          result,
        );
      } catch (e) {
        this.error = e;
        this.notify(
          e instanceof WorkspaceConflict ? "競合・未保存" : "保存失敗・未保存",
          e,
        );
        throw e;
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
    if (this.saved !== this.generation) await this.flush();
  }
  async retry() {
    if (this.error instanceof WorkspaceConflict) throw this.error;
    this.error = undefined;
    await this.flush();
  }
  resume() {
    this.stopped = false;
  }
  dispose() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.maximum);
  }
  get dirty() {
    return this.saved !== this.generation || !!this.error;
  }
}
