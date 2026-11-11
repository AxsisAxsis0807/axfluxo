import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations, migrationFiles } from "../db/migrate";

type FakeDb = {
  applied: Set<string>;
  ran: string[];
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rowCount: number | null; rows: unknown[] }>;
};

function fakeDb(): FakeDb {
  const applied = new Set<string>();
  const ran: string[] = [];
  return {
    applied,
    ran,
    async query(text, values) {
      if (text.startsWith("CREATE TABLE IF NOT EXISTS")) {
        if (!ran.includes("create-tracking")) ran.push("create-tracking");
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("SELECT 1 FROM")) {
        return {
          rowCount: applied.has(String(values?.[0])) ? 1 : 0,
          rows: [],
        };
      }
      if (text.startsWith("INSERT INTO")) {
        applied.add(String(values?.[0]));
        return { rowCount: 1, rows: [] };
      }
      ran.push(text.trim());
      return { rowCount: 0, rows: [] };
    },
  };
}

describe("database migration runner", () => {
  it("applies SQL files in order and skips them on a second run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "axfluxo-migrate-"));
    try {
      await writeFile(join(directory, "002_second.sql"), "SELECT 'second';");
      await writeFile(join(directory, "001_first.sql"), "SELECT 'first';");
      await writeFile(join(directory, "notes.txt"), "ignored");
      expect(await migrationFiles(directory)).toEqual([
        "001_first.sql",
        "002_second.sql",
      ]);

      const db = fakeDb();
      const lines: string[] = [];
      expect(await applyMigrations(db, directory, (line) => lines.push(line))).toBe(2);
      expect(db.ran).toEqual(["create-tracking", "SELECT 'first';", "SELECT 'second';"]);
      expect(lines).toEqual(["applied 001_first.sql", "applied 002_second.sql"]);

      expect(await applyMigrations(db, directory, (line) => lines.push(line))).toBe(0);
      expect(db.ran).toEqual(["create-tracking", "SELECT 'first';", "SELECT 'second';"]);
      expect(lines.slice(2)).toEqual(["skip 001_first.sql", "skip 002_second.sql"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops at the failing file and leaves it unrecorded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "axfluxo-migrate-"));
    try {
      await writeFile(join(directory, "001_broken.sql"), "SELECT broken;");
      const db = fakeDb();
      const failing = {
        ...db,
        async query(text: string, values?: unknown[]) {
          if (text === "SELECT broken;") throw new Error("syntax error");
          return db.query(text, values);
        },
      };
      const logs: string[] = [];
      await expect(
        applyMigrations(failing, directory, (line) => logs.push(line)),
      ).rejects.toThrow("syntax error");
      expect(logs).toEqual([]);
      expect(db.applied.has("001_broken.sql")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
