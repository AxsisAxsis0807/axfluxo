import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSha256, sha256File } from "../src/domain/cloud-export/sha256";

const node = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

describe("browser streaming SHA-256", () => {
  it("matches Node for known and random inputs of every size around block edges", () => {
    expect(createSha256().digest()).toBe(node(new Uint8Array()));
    for (const size of [1, 55, 56, 63, 64, 65, 127, 128, 129, 4095, 65537]) {
      const data = randomBytes(size);
      expect(createSha256().update(data).digest()).toBe(node(data));
    }
  });

  it("produces the same digest regardless of how the bytes are split", () => {
    const data = randomBytes(200_003);
    const one = createSha256().update(data).digest();
    const hasher = createSha256();
    for (let offset = 0; offset < data.byteLength; offset += 7_777)
      hasher.update(data.subarray(offset, offset + 7_777));
    expect(hasher.digest()).toBe(one);
    expect(one).toBe(node(data));
  });

  it("hashes a Blob in slices without materialising it", async () => {
    const data = randomBytes(3_000_000);
    expect(await sha256File(new Blob([data]))).toBe(node(data));
  });
});
