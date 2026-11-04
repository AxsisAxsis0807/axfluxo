import { describe, expect, it } from "vitest";
import {
  ExportQueue,
  type ExportRunner,
} from "../../../src/services/video/export-queue";
import type { LocalEncodeJob } from "../../../src/services/video/local-encode";
const job = (filename: string): LocalEncodeJob => ({
  filename,
  width: 16,
  height: 16,
  pieces: [{ start: 1, end: 2, url: async () => "blob:input" }],
  draw: () => {},
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const result = { filename: "done.mp4", blob: new Blob(["result"]) };
describe("automatic export queue", () => {
  it("serializes 3+ jobs, snapshots mutable piece values and permits enqueue during rendering", async () => {
    const calls: string[] = [],
      releases: (() => void)[] = [];
    let active = 0,
      max = 0;
    const runner: ExportRunner = async (input, _, __, update) => {
      calls.push(`${input.filename}:${input.pieces[0].start}`);
      active++;
      max = Math.max(max, active);
      update(0.5, "half");
      await new Promise<void>((r) => releases.push(r));
      active--;
      return result;
    };
    const queue = new ExportQueue(runner),
      first = job("one");
    queue.enqueue([first, job("two"), job("three")], false);
    first.pieces[0].start = 50;
    queue.enqueue([job("four")], true);
    expect(queue.getSnapshot().entries[0].progress).toBe(0.5);
    expect(queue.getSnapshot().entries[0].input?.pieces[0].start).toBe(1);
    for (let i = 0; i < 4; i++) {
      releases.shift()!();
      await settle();
    }
    expect(calls).toEqual(["one:1", "two:1", "three:1", "four:1"]);
    expect(max).toBe(1);
    expect(
      queue.getSnapshot().entries.every((e) => e.state === "completed"),
    ).toBe(true);
    expect(queue.getSnapshot().entries.every((e) => !e.input)).toBe(true);
  });
  it("holds the slot through cancellation cleanup and ignores late success", async () => {
    const releases: (() => void)[] = [],
      calls: string[] = [];
    const queue = new ExportQueue(async (input) => {
      calls.push(input.filename);
      await new Promise<void>((r) => releases.push(r));
      return result;
    });
    queue.enqueue([job("one"), job("two"), job("three")], false);
    const [one, two] = queue.getSnapshot().entries;
    queue.cancel(one.id);
    queue.cancel(two.id);
    expect(calls).toEqual(["one"]);
    releases.shift()!();
    await settle();
    expect(calls).toEqual(["one", "three"]);
    expect(queue.getSnapshot().entries[0].state).toBe("cancelled");
    releases.shift()!();
    await settle();
  });
  it("continues after failure, reorders waiting jobs, and retries with original input", async () => {
    const calls: string[] = [];
    let fail = true;
    const queue = new ExportQueue(async (input) => {
      calls.push(input.filename);
      if (input.filename === "bad" && fail) throw Error("codec");
      return result;
    });
    queue.pause();
    queue.enqueue([job("bad"), job("two"), job("three")], false);
    const [bad, , three] = queue.getSnapshot().entries;
    queue.move(three.id, -1);
    queue.resume();
    await settle();
    expect(calls).toEqual(["bad", "three", "two"]);
    expect(
      queue.getSnapshot().entries.find((e) => e.id === bad.id)?.error,
    ).toBe("codec");
    fail = false;
    queue.retry(bad.id);
    queue.retry(bad.id);
    await settle();
    expect(calls).toEqual(["bad", "three", "two", "bad"]);
  });
  it("preserves unsaved results and pauses at a retention budget; limits admission atomically", async () => {
    const queue = new ExportQueue(async () => result, 3, 10, 6);
    queue.enqueue([job("one"), job("two")], false);
    await settle();
    expect(queue.getSnapshot().paused).toBe(true);
    expect(queue.getSnapshot().entries.map((e) => e.state)).toEqual([
      "completed",
      "queued",
    ]);
    expect(queue.getSnapshot().entries[0].result?.blob).toBe(result.blob);
    expect(() => queue.enqueue([job("three"), job("four")], false)).toThrow();
    expect(queue.getSnapshot().entries).toHaveLength(2);
    queue.remove(queue.getSnapshot().entries[0].id);
    queue.resume();
    await settle();
    expect(queue.getSnapshot().entries[0].state).toBe("completed");
  });
  it("records interruption as retryable failure and pauses subsequent work", async () => {
    const queue = new ExportQueue(async (_, signal) => {
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
      return result;
    });
    queue.enqueue([job("one"), job("two")], false);
    queue.pause(true);
    await settle();
    expect(queue.getSnapshot().entries.map((e) => e.state)).toEqual([
      "failed",
      "queued",
    ]);
    expect(queue.getSnapshot().paused).toBe(true);
  });
});
