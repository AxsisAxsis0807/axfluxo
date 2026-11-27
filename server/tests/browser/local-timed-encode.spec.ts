import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("All Versions writes source-clock MP4 with trimmed audio and unique frame timestamps", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "ax-timed-"));
  try {
    for (const [name, frequency, rate, channels] of [
      ["normal", 440, 44100, 1],
      ["slowed", 660, 48000, 2],
    ] as const) {
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${frequency}:sample_rate=${rate}:duration=4.5`,
        "-ac",
        String(channels),
        "-y",
        join(directory, name + ".wav"),
      ]);
    }
    const bundle = await build({
      stdin: {
        resolveDir: resolve("."),
        contents: `
          import { buildLocalJobs } from "./src/services/video/local-project";
          import { getEncodeReport } from "./src/services/video/local-encode-diagnostics";
          import { encodeLocal, usesTimedLocalEncoding } from "./src/services/video/local-encode";
          window.run = async (gap) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 32;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#40b080";
            ctx.fillRect(0, 0, 32, 32);
            const sources = await Promise.all([
              ["normal", .13, 4.13, "2.13"], ["slowed", .271, 2.645, ""],
            ].map(async ([id, start, end, markers]) => ({
              id, file: new File([await (await fetch("/" + id + ".wav")).blob()], id + ".wav"),
              start, end, duration:4.5, markers,
            })));
            const [composition] = await buildLocalJobs({
              mode:"all-versions", cover:canvas.toDataURL(), names:"First\\nSecond\\nThird",
              ranges:[], sources,
            });
            if (composition.gapBetweenPiecesSeconds !== 0) throw Error("Production job must have no gap");
            const job = { ...composition, width:320, height:180 };
            // Zero-gap case uses the production job unchanged; retain generic gap coverage.
            if (gap) job.gapBetweenPiecesSeconds = gap;
            if (!usesTimedLocalEncoding(job)) return false;
            // Force a scheduling stall at the in-file marker.
            const draw = job.draw;
            job.draw = (ctx, media, time) => {
              if (time === 2) {
                const until = performance.now() + 180;
                while (performance.now() < until) {}
              }
              draw(ctx, media, gap && time >= 4 ? Math.max(4, time - gap) : time);
            };
            let result;
            try {
              result = await encodeLocal(job, undefined, AbortSignal.timeout(60000),
                false, {processing:0}, () => {});
            } catch (error) {
              throw new Error(JSON.stringify(getEncodeReport()) + " " + error.message);
            }
            document.querySelector("a").href = URL.createObjectURL(result.blob);
            return true;
          };
        `,
      },
      bundle: true,
      write: false,
      platform: "browser",
      define: { "process.env.NEXT_PUBLIC_BASE_PATH": '""' },
    });
    const url = "https://ax-timed.test";
    await page.route(url + "/", (route) =>
      route.fulfill({
        body: '<a download="all.mp4">Save</a>',
        contentType: "text/html",
      }),
    );
    for (const name of ["normal", "slowed"]) {
      const body = await readFile(join(directory, name + ".wav"));
      await page.route(url + "/" + name + ".wav", (route) =>
        route.fulfill({ contentType: "audio/wav", body }),
      );
    }
    for (const name of ["Aleo.ttf", "ReferenceClock.ttf"]) {
      await page.route(url + "/fonts/" + name, (route) =>
        route.fulfill({
          contentType: "font/ttf",
          path: "public/fonts/" + name,
        }),
      );
    }
    await page.goto(url);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });

    for (const gap of [0, 1]) {
      const supported = await page.evaluate(
        (seconds) =>
          (window as unknown as { run: (n: number) => Promise<boolean> }).run(
            seconds,
          ),
        gap,
      );
      test.skip(
        !supported,
        "This browser lacks WebCodecs audio/video support.",
      );
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByText("Save").click(),
      ]);
      const path = join(directory, `timed-${gap}.mp4`);
      await download.saveAs(path);
      const duration = 6.374 + gap;
      const inspect = (track: "v" | "a") =>
        JSON.parse(
          execFileSync(
            "ffprobe",
            [
              "-v",
              "error",
              "-select_streams",
              track + ":0",
              "-show_packets",
              "-show_streams",
              "-show_entries",
              "stream=duration:packet=pts_time,duration_time",
              "-of",
              "json",
              path,
            ],
            { encoding: "utf8" },
          ),
        ) as {
          streams: { duration: string }[];
          packets: { pts_time: string; duration_time: string }[];
        };
      const video = inspect("v"),
        audio = inspect("a");
      if (Math.abs(Number(audio.streams[0].duration) - duration) >= 0.00005) {
        console.log(
          JSON.stringify({
            expected: duration,
            audio: audio.streams[0],
            first: audio.packets.slice(0, 4),
            last: audio.packets.slice(-4),
          }),
        );
        await test.info().attach("audio-timing-mismatch", {
          path,
          contentType: "video/mp4",
        });
      }
      expect(Number(video.streams[0].duration)).toBeCloseTo(duration, 4);
      expect(Number(audio.streams[0].duration)).toBeCloseTo(duration, 4);
      const frames = video.packets
        .map((packet) => Number(packet.pts_time))
        .sort((a, b) => a - b);
      expect(frames).toHaveLength(Math.ceil(duration * 60));
      for (const [index, pts] of frames.entries())
        expect(pts).toBeCloseTo(index / 60, 5);
      for (const [index, packet] of audio.packets.entries()) {
        const next = audio.packets[index + 1]?.pts_time ?? duration;
        expect(
          Number(packet.pts_time) + Number(packet.duration_time),
        ).toBeCloseTo(Number(next), 4);
      }

      const pcm = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "f32le",
        "pipe:1",
      ]);
      function tone(time: number, samples = 1600) {
        const start = Math.round(time * 8000);
        let power = 0,
          crossings = 0,
          previous = start ? pcm.readFloatLE((start - 1) * 4) : 0;
        for (let i = start; i < start + samples; i++) {
          const value = pcm.readFloatLE(i * 4);
          power += value ** 2;
          if (previous <= 0 && value > 0) crossings++;
          previous = value;
        }
        return {
          rms: Math.sqrt(power / samples),
          frequency: (crossings * 8000) / samples,
        };
      }
      expect(tone(0, 160).rms).toBeGreaterThan(0.035);
      expect(tone(duration - 0.025, 160).rms).toBeGreaterThan(0.035);
      // This window straddles the version marker in the first source.
      expect(tone(1.9).rms).toBeGreaterThan(0.04);
      expect(Math.abs(tone(1.9).frequency - 440)).toBeLessThanOrEqual(5);
      expect(tone(4.2 + gap).rms).toBeGreaterThan(0.04);
      expect(Math.abs(tone(4.2 + gap).frequency - 660)).toBeLessThanOrEqual(5);
      if (gap) expect(tone(4.5).rms).toBeLessThan(0.001);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
