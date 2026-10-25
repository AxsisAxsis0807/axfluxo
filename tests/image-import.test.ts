import { afterEach, expect, it, vi } from "vitest";
import { importImage } from "../src/services/assets";

afterEach(() => vi.unstubAllGlobals());

it.each(["context", "draw", "encode", "success"])(
  "releases the import canvas and decoder URL after %s",
  async (failure) => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () =>
        failure === "context"
          ? null
          : {
              drawImage: () => {
                if (failure === "draw") throw new Error("draw failed");
              },
            },
      toBlob: (callback: (blob: Blob | null) => void) =>
        callback(
          failure === "encode"
            ? null
            : new Blob(["png"], { type: "image/png" }),
        ),
    };
    const revoke = vi.fn();
    vi.stubGlobal("document", { createElement: () => canvas });
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 16;
        naturalHeight = 16;
        decode() {
          return Promise.resolve();
        }
      },
    );
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:import-test",
      revokeObjectURL: revoke,
    });
    const file = new File([new Uint8Array([255, 216, 255])], "test.jpg");
    if (failure === "success") {
      const asset = await importImage(file);
      expect(asset.mime).toBe("image/jpeg");
      expect(asset.original?.type).toBe("image/jpeg");
      expect(asset.blob.type).toBe("image/png");
    } else await expect(importImage(file)).rejects.toThrow();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:import-test");
  },
);
