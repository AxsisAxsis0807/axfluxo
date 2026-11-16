import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { retainStaticComposite } from "../../worker/templates/all-versions/graphics";
it("evicts only the oldest owned static PNG and preserves foreign files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "av-v3-cache-"));
  try {
    const files = [0, 1, 2].map(i => join(dir, `static-${i}.png`));
    const foreign = join(dir, "foreign-checkpoint");
    await Promise.all([...files, foreign].map(p => writeFile(p, "sentinel")));
    const cache = new Map<number, string>();
    for (const [i, path] of files.entries()) await retainStaticComposite(cache, i, path);
    expect([...cache.keys()]).toEqual([1, 2]);
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(files[0])).rejects.toThrow();
    expect(await readFile(foreign, "utf8")).toBe("sentinel");
    expect(await readFile(files[1], "utf8")).toBe("sentinel");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
