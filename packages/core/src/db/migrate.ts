import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function migrationsFromDir(dir: URL): Migration[] {
  return readdirSync(dir)
    .map((file) => ({ file, match: FILE_PATTERN.exec(file) }))
    .filter((f): f is { file: string; match: RegExpExecArray } => f.match !== null)
    .map(({ file, match }) => ({
      version: Number(match[1]),
      name: String(match[2]),
      sql: readFileSync(new URL(file, dir), "utf8"),
    }));
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/** Applies pending migrations atomically. Returns the versions applied. */
export function migrate(db: DatabaseSync, migrations: Migration[]): number[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]?.version === sorted[i - 1]?.version) {
      throw new Error(`duplicate migration version ${sorted[i]?.version}`);
    }
  }

  // One write-locked transaction for check + apply: concurrent openers (gateway, CLI) serialize
  // here instead of both applying the same migration. Pending migrations apply all-or-nothing.
  db.exec("BEGIN IMMEDIATE");
  try {
    const ran = applyPending(db, sorted);
    db.exec("COMMIT");
    return ran;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function applyPending(db: DatabaseSync, sorted: Migration[]): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const known = new Map(sorted.map((m) => [m.version, m]));
  const applied = db.prepare("SELECT version, checksum FROM schema_migrations").all();
  for (const row of applied) {
    const m = known.get(Number(row.version));
    // An unknown applied version means the DB was written by a newer build (or an import from one).
    if (!m) throw new Error(`database schema v${row.version} is newer than this build`);
    if (checksum(m.sql) !== row.checksum) {
      throw new Error(`migration ${m.version}_${m.name} checksum changed after it was applied`);
    }
  }

  const done = new Set(applied.map((r) => Number(r.version)));
  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  const ran: number[] = [];
  for (const m of sorted) {
    if (done.has(m.version)) continue;
    db.exec(m.sql);
    record.run(m.version, m.name, checksum(m.sql), Date.now());
    ran.push(m.version);
  }
  return ran;
}
