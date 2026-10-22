import {
  newProject,
  newPage,
  newText,
  baseLayer,
  defaultCrop,
  uid,
  type ImageLayer,
} from "../domain/document";
import { importImage } from "./assets";
import { put } from "./storage";
/** Original procedural artwork: no third-party cover art or screenshots. */
export async function createSample() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1080;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#11090e";
  c.fillRect(0, 0, 1080, 1080);
  const gradient = c.createRadialGradient(540, 540, 20, 540, 540, 600);
  gradient.addColorStop(0, "#6f283b");
  gradient.addColorStop(1, "#100a11");
  c.fillStyle = gradient;
  c.fillRect(0, 0, 1080, 1080);
  const polygons = [
    [
      [540, 120],
      [380, 500],
      [610, 610],
    ],
    [
      [540, 120],
      [610, 610],
      [740, 370],
    ],
    [
      [380, 500],
      [230, 380],
      [540, 900],
    ],
    [
      [610, 610],
      [540, 900],
      [740, 370],
    ],
    [
      [380, 500],
      [540, 570],
      [610, 610],
    ],
    [
      [740, 370],
      [860, 700],
      [610, 610],
    ],
  ];
  polygons.forEach((points, i) => {
    c.beginPath();
    points.forEach(([x, y], j) => {
      if (j) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    c.closePath();
    c.fillStyle = [
      "#b7737c",
      "#673b60",
      "#4c244a",
      "#934458",
      "#d8a2a0",
      "#42203b",
    ][i];
    c.fill();
    c.strokeStyle = "#f6c3b770";
    c.lineWidth = 2;
    c.stroke();
  });
  for (let i = 0; i < 80; i++) {
    const x = (i * 127 + 31) % 1080,
      y = (i * i * 71 + 97) % 1080;
    c.fillStyle = i % 2 ? "#ffcfbb50" : "#ffffff33";
    c.fillRect(x, y, 2, 2);
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(Error("サンプル作成失敗")))),
  );
  canvas.width = canvas.height = 0;
  const asset = await importImage(
    new File([blob], "AxFluxo-original-geometric.png", { type: "image/png" }),
  );
  await put("assets", asset);
  const d = newProject("サンプル — 2ページの紹介画像");
  d.variables = [
    { key: "cover_image", label: "カバー画像", type: "image", required: true },
    { key: "description_en", label: "紹介文", type: "string", required: true },
    { key: "pt_number", label: "シリーズ番号", type: "number", required: true },
    {
      key: "song_title",
      label: "作品タイトル",
      type: "string",
      required: true,
    },
  ];
  d.values = {
    cover_image: asset.id,
    description_en: "This is Cosmic Future Funk…!?",
    pt_number: 163,
    song_title: "YOUR ORIGINAL",
  };
  const image: ImageLayer = {
    ...baseLayer("image"),
    kind: "image",
    width: 1080,
    height: 1080,
    assetId: asset.id,
    crop: defaultCrop(),
    effects: { brightness: 0.65, contrast: 1, saturation: 1, blur: 2 },
    imageBinding: "cover_image",
  };
  const title = {
    ...newText(),
    x: 540,
    y: 510,
    width: 1020,
    height: 110,
    fontId: "inter" as const,
    fontWeight: "400" as const,
    fontSize: 50,
    text: "",
    textBinding: { key: "description_en", prefix: "", suffix: "" },
  };
  const number = {
    ...newText(),
    x: 540,
    y: 605,
    width: 500,
    height: 100,
    fontId: "inter" as const,
    fontWeight: "400" as const,
    fontSize: 50,
    text: "",
    textBinding: { key: "pt_number", prefix: "(PT.", suffix: ")" },
  };
  d.pages[0].name = "イントロ";
  d.pages[0].layers = [image, title, number];
  const second = newPage();
  second.name = "ディテール";
  second.layers = [
    {
      ...structuredClone(image),
      id: uid(),
      effects: { brightness: 1, contrast: 1, saturation: 1, blur: 0 },
    },
    {
      ...newText(),
      x: 540,
      y: 760,
      width: 960,
      height: 140,
      fontId: "lora",
      fontSize: 60,
      text: "",
      textBinding: { key: "song_title", prefix: "SONG:", suffix: "" },
    },
  ];
  d.pages.push(second);
  return d;
}
