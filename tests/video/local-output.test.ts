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
      bad = join(dir, "audio.m4a"),
      silent = join(dir, "silent.mp4");
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
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      good,
      "-an",
      "-c:v",
      "copy",
      "-y",
      silent,
    ]);
    const signal = new AbortController().signal;
    await expect(
      validateLocalOutput(new Blob([], { type: "video/mp4" }), signal, 0.7),
    ).rejects.toMatchObject({ name: "LocalVideoOutputError" });
    await expect(
      validateLocalOutput(new Blob([await readFile(good)]), signal, 1),
    ).resolves.toBeUndefined();
    await expect(
      validateLocalOutput(new Blob([await readFile(good)]), signal, 2),
    ).rejects.toMatchObject({ name: "LocalVideoOutputError" });
    await expect(
      validateLocalOutput(new Blob([await readFile(bad)]), signal),
    ).rejects.toThrow("未検出: 映像");
    await expect(
      validateLocalOutput(new Blob([await readFile(silent)]), signal),
    ).rejects.toThrow("未検出: 音声");
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

it("checks both track ranges beyond ten minutes without decoding samples", async () => {
  const dir = await mkdtemp(join(tmpdir(), "validate-long-local-"));
  try {
    const signal = new AbortController().signal;
    for (const audioSeconds of [601, 590]) {
      const output = join(dir, `audio-${audioSeconds}.mp4`);
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=black:size=16x16:rate=1:duration=601",
        "-f",
        "lavfi",
        "-i",
        `anullsrc=r=8000:cl=mono:d=${audioSeconds}`,
        "-threads",
        "1",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-y",
        output,
      ]);
      const check = validateLocalOutput(
        new Blob([await readFile(output)], { type: "video/mp4" }),
        signal,
        601,
      );
      if (audioSeconds === 601) await expect(check).resolves.toBeUndefined();
      else await expect(check).rejects.toThrow("音声が指定区間より短い");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects an interior video freeze or audio gap even when track endpoints match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "validate-gaps-local-"));
  try {
    for (const [kind, filter] of [
      ["映像", ["-vf", "select=not(between(t\\,1\\,4))", "-fps_mode", "vfr"]],
      ["音声", ["-af", "aselect=not(between(t\\,1\\,4))"]],
    ] as const) {
      const output = join(dir, "gap.mp4");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=blue:s=16x16:r=30:d=5",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=5",
        ...filter,
        "-threads",
        "1",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-y",
        output,
      ]);
      await expect(
        validateLocalOutput(
          new Blob([await readFile(output)], { type: "video/mp4" }),
          new AbortController().signal,
          5,
        ),
      ).rejects.toThrow(`${kind}の途中`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
