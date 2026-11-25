import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("full MP3 EOF: 112.128 s sample clock and playable short MP4 without manual trim", async ({ page }) => {
  test.setTimeout(120_000);
  const dir = await mkdtemp(join(tmpdir(), "ax-eof-"));
  try {
    // Synthetic sine waves reproduce the original file's frame count and
    // gapless overhead without committing a user's music or artwork.
    for (const [name, frames, seconds] of [
      ["long", 5380097, 113], ["short", 108545, 3],
    ] as const) {
      execFileSync("ffmpeg", [
        "-v", "error", "-f", "lavfi", "-i",
        `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
        "-af", `atrim=end_sample=${frames}`, "-ac", "2",
        "-c:a", "libmp3lame", "-b:a", "192k", "-y", join(dir, name + ".mp3"),
      ]);
      // FFmpeg versions disagree on whether format.duration includes gapless
      // padding. Count physical MPEG-1 Layer III packets (1152 samples each)
      // instead, and separately verify the decoded PCM sample count.
      const packets = Number(execFileSync("ffprobe", [
        "-v", "error", "-select_streams", "a:0", "-count_packets",
        "-show_entries", "stream=nb_read_packets",
        "-of", "default=nk=1:nw=1", join(dir, name + ".mp3"),
      ], { encoding: "utf8" }));
      expect(packets * 1152 / 48000).toBeCloseTo(name === "long" ? 112.128 : 2.304, 6);
      const pcm = execFileSync("ffmpeg", [
        "-v", "error", "-i", join(dir, name + ".mp3"),
        "-f", "s16le", "pipe:1",
      ], { maxBuffer: 32 * 1024 * 1024 });
      expect(pcm.byteLength / 4).toBe(frames);
    }
    const bundle = await build({
      stdin: {
        resolveDir: resolve("."),
        contents: `
          import { Input, BlobSource, ALL_FORMATS } from "mediabunny";
          import { inspectTimedAudio, timedAudio } from "./src/services/video/local-timed-audio";
          import { encodeLocal, usesTimedLocalEncoding } from "./src/services/video/local-encode";
          import { getEncodeReport } from "./src/services/video/local-encode-diagnostics";
          async function file(name) {
            return new File([await (await fetch("/" + name + ".mp3")).blob()], name + ".mp3");
          }
          window.runLong = async () => {
            const source = await file("long");
            const signal = AbortSignal.timeout(60000);
            const make = () => new Input({source:new BlobSource(source, {maxCacheSize: 2*1024*1024,useStreamReader:false}), formats:ALL_FORMATS});
            const inspect = make();
            let plan;
            try {
              const track = await inspect.getPrimaryAudioTrack();
              if (!track || !(await track.canDecode())) return null;
              plan = await inspectTimedAudio(track, 0, 112.128, 112.128, signal);
            } finally { inspect.dispose(); }
            console.info('long MP3 preflight complete', plan.decodedEnd);
            await new Promise(resolve => setTimeout(resolve, 0));
            const input = make();
            let count = 0, last = 0;
            try {
              const track = await input.getPrimaryAudioTrack();
              for await (const sample of timedAudio(track, plan, 0, 5382144, signal)) {
                if (Math.round(sample.timestamp * 48000) !== count) throw Error("non-contiguous audio");
                count += sample.numberOfFrames;
                last = sample.timestamp + sample.numberOfFrames / 48000;
                const pcm = new Float32Array(sample.numberOfFrames);
                sample.copyTo(pcm, {planeIndex:0,format:'f32-planar'});
                if (!pcm.every(Number.isFinite)) throw Error('invalid PCM');
                sample.close();
              }
            } finally { input.dispose(); }
            return {count, last, missing:plan.limit-plan.decodedEnd};
          };
          window.runShort = async () => {
            const source = await file("short");
            const job = {timestamped:true, filename:"eof.mp4", width:160, height:90,
              pieces:[{file:source, url:async()=>URL.createObjectURL(source), start:0,end:2.304,sourceDuration:2.304}],
              draw:(ctx)=>{ctx.fillStyle="#438acb";ctx.fillRect(0,0,160,90);}};
            if (!usesTimedLocalEncoding(job)) return false;
            const result = await encodeLocal(job, undefined, AbortSignal.timeout(60000), false, {processing:0}, ()=>{});
            document.querySelector("a").href=URL.createObjectURL(result.blob);
            return getEncodeReport();
          };
        `,
      },
      bundle: true,
      write: false,
      platform: "browser",
    });
    const url = "https://audio-eof.test";
    await page.route(url + "/", (route) => route.fulfill({
      body: '<a download="eof.mp4">Save</a>', contentType: "text/html",
    }));
    for (const name of ["long", "short"]) {
      const body = await readFile(join(dir, name + ".mp3"));
      await page.route(url + "/" + name + ".mp3", (route) => route.fulfill({body, contentType:"audio/mpeg"}));
    }
    await page.goto(url);
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const long = await page.evaluate(() => (window as unknown as {
      runLong: () => Promise<{count:number;last:number;missing:number} | null>;
    }).runLong());
    expect(long, "MP3 decoder must be available in the supported CI browsers").not.toBeNull();
    expect(long?.count).toBe(5382144);
    expect(long?.last).toBeCloseTo(112.128, 6);
    expect(long?.missing).toBeGreaterThanOrEqual(0);
    expect(long?.missing).toBeLessThanOrEqual(2304);
    const short = await page.evaluate(() => (window as unknown as {
      runShort: () => Promise<{state:string} | false>;
    }).runShort());
    expect(short).toMatchObject({state:"complete"});
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByText("Save").click()]);
    const result = join(dir, "eof.mp4");
    await download.saveAs(result);
    const tracks = JSON.parse(execFileSync("ffprobe", [
      "-v","error","-show_entries","stream=codec_type,duration","-of","json",result,
    ], {encoding:"utf8"})) as {streams:{codec_type:string;duration:string}[]};
    for (const type of ["audio", "video"]) {
      const track = tracks.streams.find(s=>s.codec_type===type);
      expect(Number(track?.duration)).toBeCloseTo(2.304, 3);
    }
  } finally {
    await rm(dir, {recursive:true,force:true});
  }
});
