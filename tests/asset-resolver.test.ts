import { beforeEach, expect, it, vi } from "vitest";
import {
  baseLayer,
  defaultCrop,
  newProject,
  type ImageLayer,
} from "../src/domain/document";
import type { Asset } from "../src/services/storage";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  decode: vi.fn(),
  destroy: vi.fn(),
  toBlob: vi.fn(),
}));
vi.mock("../src/services/storage", () => ({ get: mocks.get }));
vi.mock("../src/services/assets", () => ({ decodeImage: mocks.decode }));
vi.mock("../src/services/fonts", () => ({ loadFonts: vi.fn() }));
vi.mock("konva", () => {
  class Node {
    add() {}
    on() {}
    draw() {}
    destroy = mocks.destroy;
    toBlob = mocks.toBlob;
  }
  return {
    default: { Stage: Node, Layer: Node, Rect: Node, Group: Node, Image: Node },
  };
});
import { createScene, exportPage } from "../src/renderers/scene";
import { legacyAssetResolver } from "../src/services/editor/asset-resolver";

function fixture() {
  const doc = newProject();
  const assetId = crypto.randomUUID();
  const layer: ImageLayer = {
    ...baseLayer("image"),
    kind: "image",
    assetId,
    crop: defaultCrop(),
    effects: { brightness: 1, contrast: 1, saturation: 1, blur: 0 },
  };
  doc.pages[0].layers.push(layer);
  const asset: Asset = {
    id: assetId,
    name: "fixed.png",
    width: 800,
    height: 800,
    hash: "a".repeat(64),
    mime: "image/jpeg",
    blob: new Blob(["png"], { type: "image/png" }),
    original: new Blob(["jpeg"]),
  };
  return { doc, asset, layer };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.decode.mockResolvedValue({});
  mocks.toBlob.mockResolvedValue(new Blob(["output"], { type: "image/png" }));
});
it("keeps the default Studio UUID lookup", async () => {
  const { doc, asset } = fixture();
  mocks.get.mockResolvedValue(asset);
  await createScene({} as HTMLDivElement, doc.pages[0], doc);
  expect(mocks.get).toHaveBeenCalledExactlyOnceWith("assets", asset.id);
  expect(await legacyAssetResolver(asset.id)).toBe(asset);
});
it("uses the injected resolver for a bound image without consulting the old DB", async () => {
  const { doc, asset, layer } = fixture();
  const variableId = crypto.randomUUID();
  layer.imageBinding = "photo";
  doc.variables.push({
    key: "photo",
    label: "photo",
    type: "image",
    required: false,
    default: asset.id,
  });
  doc.values.photo = variableId;
  const resolve = vi.fn().mockResolvedValue(asset);
  await createScene({} as HTMLDivElement, doc.pages[0], doc, {
    assetResolver: resolve,
  });
  expect(resolve).toHaveBeenCalledExactlyOnceWith(variableId);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.decode).toHaveBeenCalledWith(asset.blob);
});
it("missing fixed assets fail and release the partial stage without a legacy fallback", async () => {
  const { doc } = fixture();
  await expect(
    createScene({} as HTMLDivElement, doc.pages[0], doc, {
      assetResolver: async () => undefined,
    }),
  ).rejects.toThrow("画像素材が見つかりません");
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
});
it("export passes the same resolver and releases its stage and container on encode failure", async () => {
  const { doc, asset } = fixture();
  const remove = vi.fn();
  vi.stubGlobal("document", { createElement: () => ({ remove }) });
  const resolve = vi.fn().mockResolvedValue(asset);
  mocks.toBlob.mockRejectedValue(new Error("encode failed"));
  try {
    await expect(
      exportPage(doc.pages[0], doc, "png", 0.92, "#ffffff", false, resolve),
    ).rejects.toThrow("encode failed");
    expect(resolve).toHaveBeenCalledWith(asset.id);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("decode errors release the scene and do not fall back to a mutable asset", async () => {
  const { doc, asset } = fixture();
  mocks.decode.mockRejectedValue(new Error("decode failed"));
  await expect(
    createScene({} as HTMLDivElement, doc.pages[0], doc, {
      assetResolver: async () => asset,
    }),
  ).rejects.toThrow("decode failed");
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
  expect(mocks.get).not.toHaveBeenCalled();
});
it("a null encoder result is an explicit error and still releases resources", async () => {
  const { doc, asset } = fixture();
  const remove = vi.fn();
  vi.stubGlobal("document", { createElement: () => ({ remove }) });
  mocks.toBlob.mockResolvedValue(null);
  try {
    await expect(
      exportPage(
        doc.pages[0],
        doc,
        "png",
        0.92,
        "#ffffff",
        false,
        async () => asset,
      ),
    ).rejects.toThrow("画像の生成に失敗しました");
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
