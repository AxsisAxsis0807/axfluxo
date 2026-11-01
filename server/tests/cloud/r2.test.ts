import { it, expect } from "vitest";
import { r2Storage } from "../../storage/r2";
import { cloudConfiguration } from "../../storage/config";
it("signs only explicit R2 operations with bound Content-MD5 and short private access", async () => {
  const store = r2Storage({
    endpoint: "https://abc.r2.cloudflarestorage.com",
    bucket: "private-fixture",
    accessKeyId: "test-key",
    secretAccessKey: "test-secret",
  });
  const part = await store.signPart(
    "originals/owner/session",
    "upload-id",
    1,
    "a".repeat(32),
  );
  const url = new URL(part.url);
  expect(url.protocol).toBe("https:");
  expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-md5");
  expect(part.headers["Content-MD5"]).toBe(
    Buffer.from("a".repeat(32), "hex").toString("base64"),
  );
  const access = await store.access(
    "originals/owner/session",
    "video/mp4",
    "../../<name>.mp4",
  );
  expect(new URL(access.url).searchParams.get("X-Amz-Expires")).toBe("60");
  expect(Object.keys(store)).not.toContain("deleteObject");
});
it("defaults new uploads disabled and never guesses credentials or creates a bucket", () => {
  const config = cloudConfiguration({});
  expect(config.storage).toBeNull();
  expect(config.uploadsEnabled()).toBe(false);
  expect(() => cloudConfiguration({ CLOUD_R2_BUCKET: "x" })).toThrow();
  expect(() =>
    r2Storage({
      endpoint: "https://attacker.example",
      bucket: "x",
      accessKeyId: "dummy",
      secretAccessKey: "dummy",
    }),
  ).toThrow();
});
