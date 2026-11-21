import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { BlompFile } from "../../../src/domain/blomp/storage";
import {
  stageVerifiedBlomp,
  type BlompClient,
} from "../../../src/services/blomp/client";

const chunk = new Uint8Array(1024 ** 2).fill(43);
const parts = 17;
const size = chunk.length * parts;
const hash = createHash("sha256");
for (let i = 0; i < parts; i++) hash.update(chunk);
const file = {
  id: randomUUID(),
  name: "完成動画.mp4",
  status: "ready",
  size,
  sha256: hash.digest("hex"),
} as BlompFile;

it.each(["valid", "corrupt", "interrupted", "capacity"] as const)(
  "streams a 17 MiB download into private storage: %s",
  async (scenario) => {
    const controller = new AbortController();
    const download = vi.fn(async () => ({
      ok: true,
      data: { url: "https://storage.blomp.com/fixture" },
    }));
    const write = vi.fn(async (bytes: Uint8Array) => {
      expect(bytes.length).toBe(chunk.length);
      if (scenario === "interrupted") controller.abort();
    });
    const close = vi.fn(async () => {});
    const abort = vi.fn(async () => {});
    const removeEntry = vi.fn(async () => {});
    const storage = {
      estimate: async () => ({
        quota: scenario === "capacity" ? 1 : size,
        usage: 0,
      }),
      getDirectory: async () => ({
        getDirectoryHandle: async () => ({
          getFileHandle: async () => ({
            createWritable: async () => ({ write, close, abort }),
            getFile: async () => ({ size }),
          }),
          removeEntry,
        }),
      }),
    } as unknown as StorageManager;
    const transfer = vi.fn(async () => {
      let index = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(stream) {
            if (index === parts) return stream.close();
            stream.enqueue(
              scenario === "corrupt" && index === parts - 1
                ? new Uint8Array(chunk.length)
                : chunk,
            );
            index++;
          },
        }),
      );
    });
    const promise = stageVerifiedBlomp(
      { download } as unknown as BlompClient,
      file,
      controller.signal,
      storage,
      transfer,
    );
    if (scenario === "valid") {
      const result = await promise;
      expect(write).toHaveBeenCalledTimes(parts);
      expect(close).toHaveBeenCalledOnce();
      expect(removeEntry).not.toHaveBeenCalled();
      await result.release();
      expect(removeEntry).toHaveBeenCalledOnce();
    } else {
      await expect(promise).rejects.toThrow();
      expect(close).not.toHaveBeenCalled();
      if (scenario === "capacity") {
        expect(download).not.toHaveBeenCalled();
        expect(transfer).not.toHaveBeenCalled();
      } else {
        expect(abort).toHaveBeenCalledOnce();
        expect(removeEntry).toHaveBeenCalledOnce();
      }
    }
  },
);
