import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { type Migration, migrate, migrationsFromDir } from "./migrate.ts";

const m1: Migration = { version: 1, name: "a", sql: "CREATE TABLE a (x INTEGER);" };
const m2: Migration = { version: 2, name: "b", sql: "CREATE TABLE b (y INTEGER);" };

function tables(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => String(r.name));
}

describe("migrate", () => {
  it("applies pending migrations in order and records them", () => {
    const db = openDatabase(":memory:");
    expect(migrate(db, [m2, m1])).toEqual([1, 2]);
    expect(tables(db)).toEqual(["a", "b", "schema_migrations"]);
  });

  it("is idempotent", () => {
    const db = openDatabase(":memory:");
    migrate(db, [m1]);
    expect(migrate(db, [m1])).toEqual([]);
    expect(migrate(db, [m1, m2])).toEqual([2]);
  });

  it("rolls back a failing migration entirely", () => {
    const db = openDatabase(":memory:");
    const bad: Migration = { version: 1, name: "bad", sql: "CREATE TABLE c (z); SELECT nope();" };
    expect(() => migrate(db, [bad])).toThrow();
    expect(tables(db)).not.toContain("c");
    expect(migrate(db, [m1])).toEqual([1]);
  });

  it("refuses an applied migration whose content changed", () => {
    const db = openDatabase(":memory:");
    migrate(db, [m1]);
    expect(() => migrate(db, [{ ...m1, sql: `${m1.sql} -- edited` }])).toThrow(/checksum/);
  });

  it("refuses a database newer than this build", () => {
    const db = openDatabase(":memory:");
    migrate(db, [m1, m2]);
    expect(() => migrate(db, [m1])).toThrow(/newer/);
  });

  it("refuses duplicate versions", () => {
    const db = openDatabase(":memory:");
    expect(() => migrate(db, [m1, { ...m2, version: 1 }])).toThrow(/duplicate/);
  });

  it("loads NNNN_name.sql files from a directory", () => {
    const list = migrationsFromDir(new URL("./migrations/", import.meta.url));
    expect(list[0]).toMatchObject({ version: 1, name: "init" });
  });
});
