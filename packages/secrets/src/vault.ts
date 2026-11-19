import { randomBytes } from "node:crypto";
import { type Db, migrate, migrationsFromDir, openDatabase } from "@achords/core";
import { open, seal } from "./crypto.ts";
import { createRedactor } from "./redact.ts";

/** The only shape a secret ever leaves the vault in through APIs and UI (ADR-0012). */
export interface SecretStatus {
  id: string;
  set: boolean;
  last4: string | null;
  updatedAt: number | null;
}

export interface AuditEntry {
  secretId: string;
  action: "set" | "delete" | "resolve";
  actor: string;
  at: number;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LAST4_MIN_LENGTH = 12;
const REF_PREFIX = "vault:";
const MIGRATIONS = new URL("./migrations/", import.meta.url);

function checkId(id: string): void {
  if (!ID.test(id)) throw new Error(`invalid secret id: ${JSON.stringify(id)}`);
}

export interface Vault {
  set(id: string, value: string, actor: string, now?: number): void;
  status(id: string): SecretStatus;
  list(): SecretStatus[];
  delete(id: string, actor: string, now?: number): boolean;
  /** Plaintext for the broker / process injection only. Never return this from an API. */
  resolve(id: string, actor: string, now?: number): string;
  resolveRef(ref: string, actor: string, now?: number): string;
  redactor(): (text: string) => string;
  audit(id: string): AuditEntry[];
  close(): void;
}

export function openVault(path: string, masterKey: Buffer): Vault {
  const db: Db = openDatabase(path);
  migrate(db, migrationsFromDir(MIGRATIONS));

  const record = (secretId: string, action: AuditEntry["action"], actor: string, at: number) =>
    db
      .prepare("INSERT INTO audit (secret_id, action, actor, at) VALUES (?, ?, ?, ?)")
      .run(secretId, action, actor, at);

  const decrypt = (id: string, row: Record<string, unknown>): string => {
    const dek = open(masterKey, Buffer.from(row.dek as Uint8Array), `dek:${id}`);
    return open(dek, Buffer.from(row.value as Uint8Array), `value:${id}`).toString("utf8");
  };

  const toStatus = (row: Record<string, unknown>): SecretStatus => ({
    id: row.id as string,
    set: true,
    last4: row.last4 as string | null,
    updatedAt: Number(row.updated_at),
  });

  const vault: Vault = {
    set(id, value, actor, now = Date.now()) {
      checkId(id);
      const dek = randomBytes(32);
      const sealedValue = seal(dek, Buffer.from(value, "utf8"), `value:${id}`);
      const sealedDek = seal(masterKey, dek, `dek:${id}`);
      const last4 = value.length >= LAST4_MIN_LENGTH ? value.slice(-4) : null;
      db.prepare(
        `INSERT INTO secrets (id, value, dek, last4, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET value = excluded.value, dek = excluded.dek,
           last4 = excluded.last4, updated_at = excluded.updated_at`,
      ).run(id, sealedValue, sealedDek, last4, now, now);
      record(id, "set", actor, now);
    },
    status(id) {
      const row = db.prepare("SELECT id, last4, updated_at FROM secrets WHERE id = ?").get(id);
      return row ? toStatus(row) : { id, set: false, last4: null, updatedAt: null };
    },
    list() {
      return db
        .prepare("SELECT id, last4, updated_at FROM secrets ORDER BY id")
        .all()
        .map(toStatus);
    },
    delete(id, actor, now = Date.now()) {
      const r = db.prepare("DELETE FROM secrets WHERE id = ?").run(id);
      if (r.changes === 0) return false;
      record(id, "delete", actor, now);
      return true;
    },
    resolve(id, actor, now = Date.now()) {
      const row = db.prepare("SELECT value, dek FROM secrets WHERE id = ?").get(id);
      if (!row) throw new Error(`secret ${id} is not set`);
      const value = decrypt(id, row);
      record(id, "resolve", actor, now);
      return value;
    },
    resolveRef(ref, actor, now = Date.now()) {
      if (!ref.startsWith(REF_PREFIX)) throw new Error(`not a ${REF_PREFIX}<id> reference`);
      return vault.resolve(ref.slice(REF_PREFIX.length), actor, now);
    },
    redactor() {
      const rows = db.prepare("SELECT id, value, dek FROM secrets").all();
      return createRedactor(rows.map((r) => decrypt(r.id as string, r)));
    },
    audit(id) {
      return db
        .prepare("SELECT secret_id, action, actor, at FROM audit WHERE secret_id = ? ORDER BY id")
        .all(id)
        .map((r) => ({
          secretId: r.secret_id as string,
          action: r.action as AuditEntry["action"],
          actor: r.actor as string,
          at: Number(r.at),
        }));
    },
    close() {
      db.close();
    },
  };
  return vault;
}
