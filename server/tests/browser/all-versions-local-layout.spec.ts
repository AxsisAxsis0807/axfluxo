import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";
import { REFERENCE_BACKGROUND } from "../../../src/domain/video/all-versions-reference";

test("All Versions local jobs draw the cover, centered title band and version timer", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      resolveDir: resolve("."),
      contents: `
        import { buildLocalJobs } from './src/services/video/local-project';
        window.inspectShort = async () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 24;
          const cover = canvas.getContext('2d');
          cover.fillStyle = '#40b080';
          cover.fillRect(0, 0, 24, 24);
          const file = new File([], 'sound.wav');
          const [landscape, short] = await buildLocalJobs({
            mode: 'all-versions', cover: canvas.toDataURL(),
            names: 'KEPT (NORMAL)',
            sources: [{ id: 'audio', file, url: 'unused', start: 0, end: 8, duration: 8, markers: '' }],
            short: { sourceId: 'audio', start: 2, end: 5, title: 'Kept' },
            ranges: [],
          });
          canvas.width = short.width;
          canvas.height = short.height;
          const ctx = canvas.getContext('2d');
          short.draw(ctx, document.createElement('video'), 1);
          const ink = (x,y,w,h) => {
            const data = ctx.getImageData(x,y,w,h).data;
            let count = 0;
            for(let i=0; i < data.length; i+=4)
              if(data[i]>240 && data[i+1]>240 && data[i+2]>240) count++;
            return count;
          };
          const steady = {
            pixels: [419,420,1499,1500].map(y => ctx.getImageData(0,y,1,1).data[1]),
            title: ink(370,1080,340,60),
            timer: ink(470,1310,140,44),
          };
          short.draw(ctx, document.createElement('video'), 0);
          const first = {
            cover: ctx.getImageData(0,420,1,1).data[1],
            title: ink(370,1080,340,60),
            timer: ink(470,1310,140,44),
          };
          short.draw(ctx, document.createElement('video'), 3);
          return {
            ...steady,
            first,
            last: ctx.getImageData(0,420,1,1).data[1],
            fadeOut: short.audioFadeOutSeconds,
            dims: [short.width,short.height],
            trim: [short.pieces[0].start,short.pieces[0].end],
            landscapeTrim: [landscape.pieces[0].start,landscape.pieces[0].end],
            indices: [landscape.recovery.index,short.recovery.index],
          };
        };
        window.inspectMusicShowcase = async () => {
          const artwork = document.createElement("canvas");
          artwork.width = artwork.height = 64;
          const artworkContext = artwork.getContext("2d");
          artworkContext.fillStyle = "#26412f";
          artworkContext.fillRect(0, 0, 64, 64);
          artworkContext.fillStyle = "#eceffb";
          artworkContext.fillRect(28, 15, 8, 8);
          const rate = 48000, count = rate * 4;
          const bytes = new ArrayBuffer(44 + count * 2);
          const header = new DataView(bytes);
          function ascii(offset, value) {
            for (let i = 0; i < value.length; i++) header.setUint8(offset + i, value.charCodeAt(i));
          }
          ascii(0,"RIFF"); header.setUint32(4, count * 2 + 36, true); ascii(8,"WAVE");
          ascii(12,"fmt "); header.setUint32(16, 16, true); header.setUint16(20, 1, true);
          header.setUint16(22, 1, true); header.setUint32(24, rate, true);
          header.setUint32(28, rate * 2, true); header.setUint16(32, 2, true);
          header.setUint16(34, 16, true); ascii(36,"data"); header.setUint32(40,count * 2,true);
          for(let i=rate*1.5;i<count;i++) header.setInt16(44+i*2, 25000 * Math.sin(i * 2 * Math.PI * 330 / rate), true);
          const file = new File([bytes], "fixture.wav", {type:"audio/wav"});
          const [,,shortWide,secondWide] = await buildLocalJobs({
            mode:"all-versions", cover:artwork.toDataURL(),
            names:"MIX (I)\\nMIX (II)",
            sources:[{ id:"one", file,url:"unused",start:0,end:4,duration:4,markers:"2" }],
            short:{sourceId:"one",title:"Mix",start:0,end:4},
            musicShowcase:{version:1,title:"Mix (東京) " + "Very long title ".repeat(12),individual:true},
            ranges:[],
          });
          const [,portrait] = await buildLocalJobs({
            mode:"all-versions", cover:artwork.toDataURL(), names:"Mix",
            sources:[{id:"one",file,url:"unused",start:0,end:4,duration:4,markers:""}],
            short:{sourceId:"one",title:"Mix",start:0,end:4},
            musicShowcase:{version:1,title:"Mix",individual:false},ranges:[],
          });
          const signal = new AbortController().signal;
          const video = document.createElement("video");
          const draw = await portrait.prepareVideo(signal);
          const drawWide = await shortWide.prepareVideo(signal);
          const canvas=document.createElement("canvas");
          canvas.width = portrait.width; canvas.height = portrait.height;
          const ctx = canvas.getContext("2d");
          const pixel = (x,y) => Array.from(ctx.getImageData(x,y,1,1).data);
          const region = (x,y,w,h) => Array.from(ctx.getImageData(x,y,w,h).data);
          draw(ctx,video,1.4);
          const before = region(173,923,734,50);
          draw(ctx,video,2.4);
          const after = region(173,923,734,50);
          const bars = [];
          for(let x=173;x<907;x++) {
            const i=((948-923)*734+(x-173))*4;
            if(after[i]>175&&(x===173||after[i-4]<=175)) bars.push(x);
          }
          const top=pixel(540,419), bottom=pixel(540,1500);
          draw(ctx,video,1.4);
          const repeat=region(173,923,734,50).every((v,i) => v===before[i]);
          canvas.width=shortWide.width; canvas.height=shortWide.height;
          drawWide(ctx,video,0);
          const side0=region(0,0,420,1080);
          drawWide(ctx,video,2);
          const sameSide=region(0,0,420,1080).every((v,i) => v===side0[i]);
          return {top,bottom,repeat,sameSide,bars,
            changes: after.reduce((n,v,i)=>n+(v!==before[i]),0),
            ranges:[shortWide,secondWide].map(j=>j.pieces.map(p=>[p.start,p.end])),
            layouts:[[portrait.width,portrait.height],[shortWide.width,shortWide.height]]};
        };
        window.inspectLayout = async (layout, multiple = false, useCover = true) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 32;
          const cover = canvas.getContext('2d');
          cover.fillStyle = '#40b080';
          cover.fillRect(0, 0, 32, 32);
          const file = new File([], 'sound.wav');
          const [job] = await buildLocalJobs({
            mode: 'all-versions', layout, cover: useCover ? canvas.toDataURL() : '',
            names: 'PASA!(NORMAL)\\n日本語 Café',
            sources: multiple ? [
              { file, url: 'unused', start: 1, end: 3, duration: 6, markers: '' },
              { file, url: 'unused', start: 3, end: 5, duration: 6, markers: '' },
            ] : [{ file, url: 'unused', start: 1, end: 5, duration: 6, markers: '3' }],
            ranges: [],
          });
          canvas.width = job.width;
          canvas.height = job.height;
          const ctx = canvas.getContext('2d');
          const video = document.createElement('video');
          function sample(x, y, w, h) {
            const pixels = ctx.getImageData(x, y, w, h).data;
            let white = 0;
            let dark = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i] > 170 && pixels[i + 1] > 200 && pixels[i + 2] > 170) white++;
              if (pixels[i + 1] < 100) dark++;
            }
            return { white, dark };
          }
          function draw(time) {
            job.draw(ctx, video, time);
            const legacy = layout === 'provisional-v1';
            const side = legacy ? 600 : 1080;
            const left = (job.width - side) / 2;
            const top = legacy ? 130 : 0;
            const radius = side * 32 / 722;
            const corners = [false, true].flatMap((right) =>
              [false, true].map((bottom) => [0.24, 0.36].map((fraction) => {
                const inset = radius * fraction;
                const x = left + (right ? side - inset : inset);
                const y = top + (bottom ? side - inset : inset);
                return ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[1];
              })),
            );
            return {
              cover: ctx.getImageData(530, 300, 1, 1).data[1],
              corners,
              title: sample(660, 500, 600, 80),
              clock: sample(905, 925, 110, 40),
              legacyTitle: sample(660, 872, 600, 98).white,
            };
          }
          if (multiple && job.gapBetweenPiecesSeconds !== 0) throw Error('Unexpected production gap');
          return (multiple ? [0, 1, 2, 2, 3, 4] : [0, 1, 2, 3, 4, 1]).map(draw);
        };
      `,
    },
    bundle: true,
    write: false,
    platform: "browser",
    define: { "process.env.NEXT_PUBLIC_BASE_PATH": '""' },
  });
  const url = "https://axfluxo-local-layout.test";
  await page.route(url + "/", (route) =>
    route.fulfill({ body: "<html></html>", contentType: "text/html" }),
  );
  for (const font of ["Aleo.ttf", "ReferenceClock.ttf"]) {
    await page.route(url + "/fonts/" + font, (route) =>
      route.fulfill({ path: "public/fonts/" + font, contentType: "font/ttf" }),
    );
  }
  await page.route(url + "/" + REFERENCE_BACKGROUND, (route) =>
    route.fulfill({ path: "public/" + REFERENCE_BACKGROUND, contentType: "image/webp" }),
  );
  await page.goto(url);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const short = await page.evaluate(() => (window as unknown as {
    inspectShort: () => Promise<{
      dims: number[]; trim: number[]; landscapeTrim: number[];
      indices: number[]; pixels: number[]; title: number; timer: number;
      first: { cover: number; title: number; timer: number };
      last: number; fadeOut: number;
    }>;
  }).inspectShort());
  expect(short.dims).toEqual([1080, 1920]);
  expect(short.trim).toEqual([2, 5]);
  expect(short.landscapeTrim).toEqual([0, 8]);
  expect(short.indices).toEqual([0, 1]);
  expect([short.pixels[0], short.pixels[3]]).toEqual([0, 0]);
  expect(short.pixels[1]).toBe(short.pixels[2]);
  expect(short.pixels[1]).toBeGreaterThan(170);
  expect(short.pixels[1]).toBeLessThan(180);
  expect(short.title).toBeGreaterThan(100);
  expect(short.timer).toBeGreaterThan(60);
  expect(short.first.cover).toBeGreaterThan(40);
  expect(short.first.cover).toBeLessThan(50);
  expect(short.first.title).toBeGreaterThan(100);
  expect(short.first.timer).toBe(0);
  expect(short.last).toBe(0);
  expect(short.fadeOut).toBe(2);

  const showcase = await page.evaluate(() => (window as unknown as {
    inspectMusicShowcase: () => Promise<{
      top: number[]; bottom: number[]; repeat: boolean; sameSide: boolean;
      bars: number[]; changes: number; ranges: number[][][]; layouts: number[][];
    }>;
  }).inspectMusicShowcase());
  expect(showcase.top).toEqual([0, 0, 0, 255]);
  expect(showcase.bottom).toEqual([0, 0, 0, 255]);
  expect(showcase.repeat && showcase.sameSide).toBe(true);
  expect(showcase.changes).toBeGreaterThan(50);
  expect(showcase.bars).toHaveLength(104);
  expect((showcase.bars.at(-1)! - showcase.bars[0]) / 103).toBeCloseTo(7.04, 1);
  expect(showcase.ranges).toEqual([[[0, 2]], [[2, 4]]]);
  expect(showcase.layouts).toEqual([[1080, 1920], [1920, 1080]]);

  type Sample = {
    cover: number;
    corners: [number, number][];
    title: { white: number; dark: number };
    clock: { white: number };
    legacyTitle: number;
  };
  const draw = (layout?: string, multiple = false, useCover = true) =>
    page.evaluate(
      ({ layout: value, multiple, useCover }) =>
        (
          window as unknown as {
            inspectLayout: (layout?: string, multiple?: boolean, useCover?: boolean) => Promise<Sample[]>;
          }
        ).inspectLayout(value, multiple, useCover),
      { layout, multiple, useCover },
    );
  const [start, normal, boundary, slowed, end, seek] = await draw();
  expect(normal.cover).toBeGreaterThan(120);
  const [, fallback] = await draw(undefined, false, false);
  expect(fallback.cover).toBeGreaterThan(0);
  expect(fallback.cover).not.toBe(normal.cover);
  expect(normal.title.white).toBeGreaterThan(100);
  expect(normal.title.dark).toBeGreaterThan(100);
  expect(normal.clock.white).toBeGreaterThan(40);
  expect(slowed.title.white).toBeGreaterThan(100);
  expect(slowed.clock).toEqual(normal.clock);
  for (const frame of [start, boundary, end]) {
    expect(frame.cover).toBe(normal.cover);
    expect(frame.title.white).toBe(0);
    expect(frame.clock.white).toBe(0);
  }
  expect(seek).toEqual(normal);
  const [, legacy] = await draw("provisional-v1");
  for (const frame of [normal, legacy]) {
    expect(frame.corners).toHaveLength(4);
    for (const [outside, inside] of frame.corners) {
      expect(outside).toBeLessThan(176);
      expect(inside).toBe(176);
    }
  }
  expect(legacy.cover).toBeLessThan(normal.cover);
  expect(legacy.title.white).toBe(0);
  expect(legacy.legacyTitle).toBeGreaterThan(100);
  const [, before, gapStart, gapMiddle, after, final] = await draw(undefined, true);
  for (const frame of [gapStart, gapMiddle, final]) {
    expect(frame.cover).toBe(before.cover);
    expect(frame.title.white).toBe(0);
    expect(frame.clock.white).toBe(0);
  }
  expect(after.title.white).toBeGreaterThan(100);
  expect(after.clock).toEqual(before.clock);
  const [, legacyBefore, legacyGapStart, legacyGapMiddle, legacyAfter, legacyFinal] = await draw("provisional-v1", true);
  for (const frame of [legacyGapStart, legacyGapMiddle, legacyFinal])
    expect(frame.legacyTitle).toBe(0);
  expect(legacyBefore.legacyTitle).toBeGreaterThan(100);
  expect(legacyAfter.legacyTitle).toBeGreaterThan(100);
});
