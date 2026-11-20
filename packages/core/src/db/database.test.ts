import { describe, expect, it } from "vitest";
import { openDatabase, transaction } from "./database.ts";

describe("transaction", () => {
  it("nests: an inner call joins the outer transaction, and an error rolls back everything", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (v INTEGER)");
    transaction(db, () => {
      db.exec("INSERT INTO t VALUES (1)");
      transaction(db, () => db.exec("INSERT INTO t VALUES (2)"));
    });
    expect(() =>
      transaction(db, () => {
        db.exec("INSERT INTO t VALUES (3)");
        transaction(db, () => {
          throw new Error("inner");
        });
      }),
    ).toThrow("inner");
    expect(
      db
        .prepare("SELECT v FROM t ORDER BY v")
        .all()
        .map((r) => r.v),
    ).toEqual([1, 2]);
    // Usable again afterwards.
    transaction(db, () => db.exec("INSERT INTO t VALUES (4)"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()?.n).toBe(3);
  });
});
