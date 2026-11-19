import { DatabaseSync } from "node:sqlite";
import { migrate, migrationsFromDir } from "./migrate.ts";

export type Db = DatabaseSync;

const BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  enableWal(db);
  db.exec("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  return db;
}

// WAL lets the gateway read while an agent run writes. When several processes race to switch a
// fresh file to WAL, SQLite can return BUSY without consulting the busy handler, so retry here.
// WAL is persistent, so this only matters the first time a database file is created.
function enableWal(db: Db): void {
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (err) {
      const busy = (err as { errcode?: number }).errcode === SQLITE_BUSY;
      if (!busy || Date.now() > deadline) throw err;
      Atomics.wait(sleep, 0, 0, 10);
    }
  }
}

const CORE_MIGRATIONS = new URL("./migrations/", import.meta.url);

export function openCoreDatabase(path: string): Db {
  const db = openDatabase(path);
  migrate(db, migrationsFromDir(CORE_MIGRATIONS));
  return db;
}

// BEGIN IMMEDIATE takes the write lock up front, so read-then-write sequences cannot interleave.
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
