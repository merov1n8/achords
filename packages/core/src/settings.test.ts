import { describe, expect, it } from "vitest";
import { openCoreDatabase } from "./db/database.ts";
import { getSetting, setSetting } from "./settings.ts";

describe("settings", () => {
  it("stores and overwrites values", () => {
    const db = openCoreDatabase(":memory:");
    expect(getSetting(db, "k")).toBeUndefined();
    setSetting(db, "k", "1");
    setSetting(db, "k", "2");
    expect(getSetting(db, "k")).toBe("2");
  });
});
