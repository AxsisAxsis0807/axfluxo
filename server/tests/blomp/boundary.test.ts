import { build } from "esbuild";
import { expect, it } from "vitest";
/** Representative shared frontend entry graph: importing server code breaks this contract. */
it("keeps Blomp server credentials and adapter out of client export/auth/workflow bundles", async () => {
  const result = await build({
    entryPoints: [
      "src/services/video/local-export-runtime.ts",
      "src/services/auth.ts",
      "src/services/blomp/client.ts",
      "src/services/workflow/runner.ts",
    ],
    outdir: "unused-client-boundary",
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  expect(
    Object.keys(result.metafile!.inputs).some(
      (path) =>
        path.startsWith("server/") && path !== "server/contracts/video.ts",
    ),
  ).toBe(false);
  for (const file of result.outputFiles) {
    expect(file.text).not.toMatch(
      /BLOMP_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)|dummy-secret/,
    );
  }
});
