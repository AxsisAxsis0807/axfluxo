import { expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import fonts from "../public/fonts/manifest.json";
import { restoreWorkspace } from "../src/services/workspace/backup";
import { newWorkspace } from "../src/services/workspace/repository";
import { safeUnzip } from "../src/services/backup";
const zip = (entries: Record<string, Uint8Array>) =>
  new File([zipSync(entries) as Uint8Array<ArrayBuffer>], "bad.zip");
it("new and legacy ZIP policies remain separate and reject traversal/unknown entries", async () => {
  for (const name of [
    "../workspace.json",
    "/workspace.json",
    "assets/a\\b.png",
    "anything.html",
  ]) {
    await expect(
      restoreWorkspace(zip({ [name]: strToU8("{}") })),
    ).rejects.toThrow();
  }
  expect(() =>
    safeUnzip(zipSync({ "workspace.json": strToU8("{}") })),
  ).toThrow();
});
it("new backups reject unknown format, invalid JSON and duplicate central entries", async () => {
  await expect(
    restoreWorkspace(
      zip({
        "workspace.json": strToU8("{}"),
        "manifest.json": strToU8(
          JSON.stringify({ identifier: "unknown", formatVersion: 1 }),
        ),
      }),
    ),
  ).rejects.toThrow();
  await expect(
    restoreWorkspace(
      zip({ "workspace.json": strToU8("{"), "manifest.json": strToU8("{}") }),
    ),
  ).rejects.toThrow();
  const bytes = zipSync({
    "workspace.json": strToU8("{}"),
    "manifest.json": strToU8("{}"),
  });
  await expect(
    restoreWorkspace(
      new File(
        [bytes.slice(0, -10) as Uint8Array<ArrayBuffer>],
        "truncated.zip",
      ),
    ),
  ).rejects.toThrow();
});
it("hash mismatches are rejected before image decode or any database write", async () => {
  const id = crypto.randomUUID(),
    manifest = {
      identifier: "axfluxo-workspace",
      formatVersion: 1,
      renderVersion: 1,
      fonts,
      assets: [
        {
          id,
          name: "bad.png",
          hash: "a".repeat(64),
          originalHash: "b".repeat(64),
          originalMime: "image/png",
          width: 1,
          height: 1,
        },
      ],
      artifacts: [],
    };
  const payload = {
    workflow: newWorkspace(),
    viewport: { x: 0, y: 0, zoom: 1 },
    editors: [],
    revisions: [],
    outputs: {},
  };
  await expect(
    restoreWorkspace(
      zip({
        "workspace.json": strToU8(JSON.stringify(payload)),
        "manifest.json": strToU8(JSON.stringify(manifest)),
        [`assets/${id}.png`]: new Uint8Array([1]),
        [`assets/${id}.original`]: new Uint8Array([2]),
      }),
    ),
  ).rejects.toThrow("hash");
});
it("enforces entry count, JSON size and depth before restore publication", async () => {
  const entries: Record<string, Uint8Array> = {};
  for (let i = 0; i < 501; i++) entries[`assets/${i}.png`] = new Uint8Array();
  await expect(restoreWorkspace(zip(entries))).rejects.toThrow();
  await expect(
    restoreWorkspace(
      zip({
        "manifest.json": strToU8(" ".repeat(5 * 1024 * 1024 + 1)),
        "workspace.json": strToU8("{}"),
      }),
    ),
  ).rejects.toThrow("JSON");
  let value: unknown = {};
  for (let i = 0; i < 34; i++) value = { nested: value };
  await expect(
    restoreWorkspace(
      zip({
        "manifest.json": strToU8(JSON.stringify(value)),
        "workspace.json": strToU8("{}"),
      }),
    ),
  ).rejects.toThrow("深すぎ");
});
