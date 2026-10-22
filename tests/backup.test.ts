import { it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { safeUnzip } from "../src/services/backup";
it("accepts whitelisted entries and rejects traversal, external references and truncation", () => {
  const data = {
    "document.json": strToU8('{"ok":true}'),
    "manifest.json": strToU8("{}"),
  };
  expect(Object.keys(safeUnzip(zipSync(data)))).toEqual([
    "document.json",
    "manifest.json",
  ]);
  for (const name of [
    "../document.json",
    "/document.json",
    "assets/../../secret",
    "https://example.com/pic",
    "assets/a\\b.png",
  ])
    expect(() => safeUnzip(zipSync({ [name]: strToU8("bad") }))).toThrow();
  expect(() => safeUnzip(zipSync(data).slice(0, 30))).toThrow();
});
it("rejects duplicated central names and excessive entry counts", () => {
  const bytes = zipSync({
    "document.json": strToU8("{}"),
    "manifest.json": strToU8("{}"),
  });
  const name = strToU8("manifest.json"),
    replacement = strToU8("document.json");
  for (let i = 0; i <= bytes.length - name.length; i++)
    if (name.every((b, j) => bytes[i + j] === b)) bytes.set(replacement, i);
  expect(() => safeUnzip(bytes)).toThrow();
  const entries: Record<string, Uint8Array> = {};
  for (let i = 0; i < 501; i++) entries[`assets/${i}.png`] = new Uint8Array();
  expect(() => safeUnzip(zipSync(entries))).toThrow();
});
