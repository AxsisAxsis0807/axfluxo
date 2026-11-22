import { buildLocalJobs, type LocalProjectData } from "../../../src/services/video/local-project";
import { imageForEncode } from "../../../src/services/video/local-encode";

function legacyLine(ctx: CanvasRenderingContext2D, text: string, y: number, max: number, size = 56) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  do { ctx.font = `700 ${size--}px sans-serif`; }
  while (ctx.measureText(text).width > max && size > 10);
  ctx.lineWidth = 6;
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  ctx.strokeText(text, ctx.canvas.width / 2, y, max);
  ctx.fillText(text, ctx.canvas.width / 2, y, max);
}
function canvas(w: number, h: number) {
  const element = document.createElement("canvas");
  element.width = w; element.height = h;
  return element;
}
function compare(expected: HTMLCanvasElement, actual: HTMLCanvasElement) {
  const a = expected.getContext("2d")!.getImageData(0, 0, expected.width, expected.height).data;
  const b = actual.getContext("2d")!.getImageData(0, 0, actual.width, actual.height).data;
  let total = 0, max = 0, major = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i]);
    total += delta;
    max = Math.max(max, delta);
    if (delta > 4) major++;
  }
  return { mean: total / a.length, max, major };
}
async function compareStaticRendering() {
  const art = canvas(128, 128);
  const artCtx = art.getContext("2d")!;
  artCtx.fillStyle = "#165633"; artCtx.fillRect(0, 0, 128, 128);
  artCtx.fillStyle = "#b5d8f0"; artCtx.fillRect(16, 12, 83, 71);
  artCtx.fillStyle = "#643f84"; artCtx.fillRect(65, 40, 60, 78);
  const cover = art.toDataURL("image/png");
  const file = new File(["unused"], "original.mp4", { type: "video/mp4" });
  const source = { id: "src", file, url: "", duration: 3, width: 320, height: 180, start: 0, end: 3, markers: "" };
  const project: LocalProjectData = {
    id: "project", mode: "all-versions", sources: [source], cover, coverId: "cover",
    names: "NORMAL", ranges: [], username: "@Axsis", scaleFactor: 1,
    cropTop: 0, cropBottom: 0,
  };
  const image = await imageForEncode(cover);
  const [all] = await buildLocalJobs(project);
  const actual = canvas(1920, 1080), expected = canvas(1920, 1080);
  all.draw(actual.getContext("2d")!, document.createElement("video"), 3.5);
  const ctx = expected.getContext("2d")!;
  ctx.fillStyle = "black"; ctx.fillRect(0, 0, 1920, 1080);
  ctx.save(); ctx.globalAlpha = 0.65; ctx.filter = "blur(24px)";
  const scale = Math.max(2080 / image.width, 1200 / image.height);
  ctx.drawImage(image, (1920 - image.width * scale) / 2,
    (1080 - image.height * scale) / 2, image.width * scale, image.height * scale);
  ctx.restore();
  const crop = Math.min(image.width, image.height);
  ctx.drawImage(image, (image.width - crop) / 2, (image.height - crop) / 2,
    crop, crop, 660, 130, 600, 600);
  const allResult = compare(expected, actual);
  const fnfProject: LocalProjectData = { ...project, mode: "fnf-showcase", cover: "",
    ranges: [{ id: "range", start: 0, end: 1, name: "Song Name" }] };
  const [fnf] = await buildLocalJobs(fnfProject);
  const videoCanvas = canvas(320, 180);
  const videoCtx = videoCanvas.getContext("2d")!;
  videoCtx.fillStyle = "#6259af"; videoCtx.fillRect(0, 0, 320, 180);
  videoCtx.fillStyle = "#ec8f84"; videoCtx.fillRect(100, 40, 140, 100);
  const fnfActual = canvas(1080, 1920), fnfExpected = canvas(1080, 1920);
  fnf.draw(fnfActual.getContext("2d")!, videoCanvas as unknown as HTMLVideoElement, 0);
  const f = fnfExpected.getContext("2d")!;
  f.fillStyle = "black"; f.fillRect(0, 0, 1080, 1920);
  const resized = Math.min(1080 / 320, 1400 / 180);
  const w = 320 * resized, h = 180 * resized;
  f.drawImage(videoCanvas, 0, 0, 320, 180, (1080 - w) / 2, (1920 - h) / 2, w, h);
  legacyLine(f, "HIGH QUALITY VERSION IS ON YOUTUBE", 130, 1000, 46);
  legacyLine(f, "Song Name", 240, 1000, 44);
  legacyLine(f, "@Axsis", 1770, 1000, 64);
  return {
    all: allResult, fnf: compare(fnfExpected, fnfActual),
    dimensions: [all.width, all.height, fnf.width, fnf.height],
    filenames: [all.filename, fnf.filename],
  };
}
(window as typeof window & { compareStaticRendering?: typeof compareStaticRendering }).compareStaticRendering = compareStaticRendering;
