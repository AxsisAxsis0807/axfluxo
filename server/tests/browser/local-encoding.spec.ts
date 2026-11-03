import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
let server: Server, url: string, bundle: string, source: Buffer, dir: string;
test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "axfluxo-local-"));
  const path = join(dir, "source.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=60:d=2.1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2.1",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-c:a",
    "aac",
    "-y",
    path,
  ]);
  source = await readFile(path);
  bundle = (
    await build({
      entryPoints: [
        new URL("local-encoding-fixture.ts", import.meta.url).pathname,
      ],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      define: { "process.env": "{}" },
    })
  ).outputFiles[0].text;
  server = createServer(async (req, res) => {
    try {
      if (req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        res.end('<script src="/fixture.js"></script>');
      } else if (req.url === "/fixture.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(bundle);
      } else if (req.url === "/source.mp4") {
        res.setHeader("Content-Type", "video/mp4");
        res.end(source);
      } else if (/^\/local-encoding\/[\w.-]+$/.test(req.url ?? "")) {
        const name = req.url!.split("/").at(-1)!;
        res.setHeader(
          "Content-Type",
          name.endsWith(".js")
            ? "text/javascript"
            : name.endsWith(".wasm")
              ? "application/wasm"
              : "application/octet-stream",
        );
        res.end(await readFile(join("public/local-encoding", name)));
      } else {
        res.statusCode = 404;
        res.end();
      }
    } catch {
      res.statusCode = 500;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(
  () =>
    new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    ),
);
for (const mode of ["av", "fnf"] as const)
  test(`single-thread local ${mode} encodes checkpoint chunks and muxes H264/AAC MP4 without a render API`, async ({
    page,
  }) => {
    test.setTimeout(240000);
    const external: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(url) && !r.url().startsWith(`blob:${url}`))
        external.push(r.url());
    });
    await page.goto(url);
    const result = await page.evaluate(
      async (m) =>
        (
          window as unknown as {
            encodeLocal: (mode: string) => Promise<number[]>;
          }
        ).encodeLocal(m),
      mode,
    );
    const path = join(dir, `${mode}-${test.info().project.name}.mp4`);
    await writeFile(path, Buffer.from(result));
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
        { encoding: "utf8" },
      ),
    );
    const video = probe.streams.find(
        (s: { codec_type: string }) => s.codec_type === "video",
      ),
      audio = probe.streams.find(
        (s: { codec_type: string }) => s.codec_type === "audio",
      );
    expect(video.codec_name).toBe("h264");
    expect(video.color_space).toBe("bt709");
    expect(video.color_transfer).toBe("bt709");
    expect(video.color_primaries).toBe("bt709");
    expect(video.r_frame_rate).toBe("60/1");
    expect(video.width).toBe(mode === "av" ? 1920 : 1080);
    expect(video.height).toBe(mode === "av" ? 1080 : 1920);
    expect(Number(video.nb_frames)).toBe(126);
    expect(audio.codec_name).toBe("aac");
    expect(audio.sample_rate).toBe("48000");
    expect(audio.channels).toBe(2);
    expect(Number(probe.format.duration)).toBeCloseTo(2.1, 1);
    const rms = (file: string) => {
      const data = execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-ss",
          "0.2",
          "-i",
          file,
          "-t",
          "1.5",
          "-af",
          "pan=mono|c0=c0",
          "-f",
          "f32le",
          "-",
        ],
        { maxBuffer: 2 * 1024 * 1024 },
      );
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data.readFloatLE(i) ** 2;
      return Math.sqrt(sum / (data.length / 4));
    };
    expect(rms(path) / rms(join(dir, "source.mp4"))).toBeCloseTo(1, 1);
    expect(external).toEqual([]);
  });
