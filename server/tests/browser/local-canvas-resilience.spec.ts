import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Scenario = { count: number; seconds: number; width: number; height: number; injectAt: number };
type Result = { injected: number; state: string; route: string };

async function fixture(page: Page, dir: string, long: boolean) {
  const seconds = long ? 113 : 3;
  const frames = long ? 5380097 : 108545;
  const source = join(dir, "source.mp3");
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=48000:duration=" + seconds,
    "-af", "atrim=end_sample=" + frames, "-ac", "2", "-c:a",
    "libmp3lame", "-b:a", "192k", "-y", source,
  ]);
  const bundle = await build({
    stdin: { resolveDir: resolve("."), contents: `
      import { encodeLocal, usesTimedLocalEncoding } from "./src/services/video/local-encode";
      import { getEncodeReport } from "./src/services/video/local-encode-diagnostics";
      window.run = async ({count,seconds,width,height,injectAt}) => {
        const source = new File([await (await fetch("/source.mp3")).blob()], "source.mp3");
        const NativeFrame = window.VideoFrame;
        const total = count * seconds + (count - 1) * 1.5;
        let injected = 0;
        const job = {
          timestamped: true, filename: "resilience.mp4", width, height,
          gapBetweenPiecesSeconds: 1.5,
          pieces: Array.from({length:count}, () => ({
            file:source, url:async()=>URL.createObjectURL(source),
            start:0,end:seconds,sourceDuration:seconds,
          })),
          draw:(ctx,_media,time)=>{
            ctx.fillStyle = "#4080c0";
            ctx.fillRect(0,0,width,height);
            ctx.fillStyle = "#f0b030";
            ctx.fillRect(0,0,Math.floor(width*(0.1+0.3*(time/total))),height/3);
          },
        };
        if (!usesTimedLocalEncoding(job)) throw Error("WebCodecs required");
        if (injectAt >= 0) {
          window.VideoFrame = new Proxy(NativeFrame, {
            construct(target,args,newTarget) {
              const [image,init] = args;
              if (!injected && image instanceof HTMLCanvasElement &&
                  image.width === width && image.height === height &&
                  init?.timestamp >= injectAt*total*1000000) {
                injected++;
                throw new DOMException("Canvas has no frame","InvalidStateError");
              }
              return Reflect.construct(target,args,newTarget);
            }
          });
        }
        try {
          const result = await encodeLocal(job, undefined, AbortSignal.timeout(540000),
            false, {processing:0}, () => {});
          const link = document.querySelector("a");
          if (link.href.startsWith("blob:")) URL.revokeObjectURL(link.href);
          link.href = URL.createObjectURL(result.blob);
          return { injected, ...getEncodeReport() };
        } finally { window.VideoFrame = NativeFrame; }
      };
    ` },
    bundle: true, write: false, platform: "browser",
  });
  const url = "https://canvas-resilience.test";
  await page.route(url + "/", route => route.fulfill({
    body: '<a download="resilience.mp4">Save</a>', contentType: "text/html",
  }));
  const body = await readFile(source);
  await page.route(url + "/source.mp3", route => route.fulfill({body, contentType:"audio/mpeg"}));
  await page.goto(url);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
}

async function run(page: Page, dir: string, scenario: Scenario) {
  const result = await page.evaluate(
    s => (window as unknown as {run:(s:Scenario)=>Promise<Result>}).run(s),
    scenario,
  );
  expect(result).toMatchObject({state:"complete", route:"WebCodecs",
    injected:scenario.injectAt < 0 ? 0 : 1});
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByText("Save").click()]);
  const output = join(dir, "result.mp4");
  await download.saveAs(output);
  const duration = scenario.count*scenario.seconds + (scenario.count-1)*1.5;
  const tracks = JSON.parse(execFileSync("ffprobe", [
    "-v","error","-show_entries","stream=codec_type,duration,width,height,nb_frames",
    "-of","json",output,
  ], {encoding:"utf8"})) as {streams:{codec_type:string;duration:string;width?:number;height?:number;nb_frames?:string}[]};
  const video = tracks.streams.find(s=>s.codec_type==="video");
  const audio = tracks.streams.find(s=>s.codec_type==="audio");
  expect(video).toMatchObject({width:scenario.width,height:scenario.height});
  expect(Number(video?.duration)).toBeCloseTo(duration,3);
  expect(Number(audio?.duration)).toBeCloseTo(duration,3);
  expect(Number(video?.nb_frames)).toBe(Math.ceil(Math.round(duration*48000)/800));
  // Decode the entire MP4, not just headers. Check actual signal within each
  // track and actual silence at the centre of each fixed inter-file gap.
  execFileSync("ffmpeg", ["-v","error","-xerror","-i",output,"-f","null","-"]);
  const pcm = execFileSync("ffmpeg", ["-v","error","-i",output,"-vn",
    "-ac","1","-ar","8000","-f","f32le","pipe:1"], {maxBuffer:32*1024*1024});
  function rms(time:number) {
    const start = Math.round(time*8000);
    let sum = 0;
    for(let i=start;i<start+800;i++) sum += pcm.readFloatLE(i*4)**2;
    return Math.sqrt(sum/800);
  }
  for(let i=0;i<scenario.count;i++) {
    const start=i*(scenario.seconds+1.5);
    expect(rms(start+0.3)).toBeGreaterThan(0.025);
    expect(rms(start+scenario.seconds-0.3)).toBeGreaterThan(0.025);
    if(i<scenario.count-1) expect(rms(start+scenario.seconds+0.6)).toBeLessThan(0.002);
  }
  // Check that recovery actually draws the requested picture rather than
  // substituting black or duplicating the last good frame.
  for(const time of [duration*0.1,duration*0.5,duration*0.95]) {
    const rgb=execFileSync("ffmpeg", ["-v","error","-ss",String(time),"-i",output,
      "-frames:v","1","-vf","scale=1:1","-pix_fmt","rgb24","-f","rawvideo","pipe:1"]);
    expect(rgb.length).toBe(3);
    expect(rgb[2]).toBeGreaterThan(100);
    expect(rgb[1]).toBeGreaterThan(70);
  }
}

test("canvas capture recovery at 21 and 85 percent, consecutive four-piece MP4 exports", async ({page})=>{
  test.setTimeout(180000);
  const dir=await mkdtemp(join(tmpdir(),"ax-canvas-"));
  try {
    await fixture(page,dir,false);
    for(const injectAt of [0.21,0.85]) await run(page,dir,{
      count:4,seconds:2.304,width:910,height:512,injectAt,
    });
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("four full-length MP3 pieces export through EOF with all three 1.5-second gaps", async ({page})=>{
  test.setTimeout(660000);
  const dir=await mkdtemp(join(tmpdir(),"ax-canvas-long-"));
  try {
    await fixture(page,dir,true);
    await run(page,dir,{count:4,seconds:112.128,width:320,height:180,injectAt:-1});
  } finally { await rm(dir,{recursive:true,force:true}); }
});
