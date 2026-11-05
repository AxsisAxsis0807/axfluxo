import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateLocalOutput } from "../../src/services/video/local-output";
it("accepts real video/audio packets and rejects a nonempty audio-only MP4 before completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "validate-local-"));
  try {
    const good = join(dir, "good.mp4"),
      bad = join(dir, "audio.m4a");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:size=16x16:rate=30:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-c:a",
      "aac",
      "-y",
      good,
    ]);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      good,
      "-vn",
      "-c:a",
      "copy",
      "-y",
      bad,
    ]);
    const signal = new AbortController().signal;
    await expect(
      validateLocalOutput(new Blob([await readFile(good)]), signal),
    ).resolves.toBeUndefined();
    await expect(
      validateLocalOutput(new Blob([await readFile(bad)]), signal),
    ).rejects.toThrow("映像または音声");
    await expect(
      validateLocalOutput(
        new Blob([await readFile(good)], { type: "video/webm" }),
        signal,
      ),
    ).rejects.toThrow("形式が要求した形式と一致しません");
    const abort = new AbortController();
    abort.abort(Error("cancelled"));
    await expect(
      validateLocalOutput(new Blob([await readFile(good)]), abort.signal),
    ).rejects.toThrow("cancelled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
