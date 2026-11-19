import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { type Db, transaction } from "./db/database.ts";

export type PairingPurpose = "web" | "telegram";

export class AuthError extends Error {}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CODE_TTL_MS = 10 * MIN;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * MIN;
const SESSION_IDLE_MS = 14 * DAY;
const SESSION_MAX_AGE_MS = 90 * DAY;
// No 0/O/1/I/L: codes are read off a terminal and typed on a phone.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** 8 characters (~39 bits), single use, 10 minutes. Only its hash is stored. */
export function createPairingCode(db: Db, purpose: PairingPurpose, now = Date.now()): string {
  const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  db.prepare(
    "INSERT INTO pairing_codes (code_hash, purpose, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(sha256(raw), purpose, now, now + CODE_TTL_MS);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Consumes a pairing code. After MAX_FAILURES wrong codes within the window, all attempts are
 * refused until the window passes, and every outstanding code for that purpose is burned, so a
 * brute-forcer cannot simply wait out the lockout against the same code.
 */
export function redeemPairingCode(
  db: Db,
  purpose: PairingPurpose,
  code: string,
  now = Date.now(),
): true {
  // The outcome is decided inside the transaction but thrown after COMMIT: throwing inside would
  // roll back the recorded failure and the burned codes, silently disabling the lockout.
  const outcome = transaction(db, (): "ok" | "locked" | "invalid" => {
    const recent = db
      .prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE purpose = ? AND at > ?")
      .get(purpose, now - FAILURE_WINDOW_MS);
    if (Number(recent?.n) >= MAX_FAILURES) return "locked";
    const r = db
      .prepare(
        `UPDATE pairing_codes SET used_at = ?
         WHERE code_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .run(now, sha256(normalizeCode(code)), purpose, now);
    if (r.changes === 1) return "ok";

    db.prepare("INSERT INTO auth_failures (purpose, at) VALUES (?, ?)").run(purpose, now);
    if (Number(recent?.n) + 1 >= MAX_FAILURES) {
      db.prepare("UPDATE pairing_codes SET used_at = ? WHERE purpose = ? AND used_at IS NULL").run(
        now,
        purpose,
      );
    }
    return "invalid";
  });
  if (outcome === "locked")
    throw new AuthError("too many attempts; try again later with a new code");
  if (outcome === "invalid") throw new AuthError("invalid or expired code");
  return true;
}

export interface NewSession {
  id: string;
  /** Cookie value. Returned once, stored only as a hash. */
  token: string;
  csrf: string;
}

export interface SessionInfo {
  id: string;
  deviceName: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export function createSession(db: Db, deviceName: string, now = Date.now()): NewSession {
  const session = {
    id: randomUUID(),
    token: randomBytes(32).toString("base64url"),
    csrf: randomBytes(24).toString("base64url"),
  };
  db.prepare(
    `INSERT INTO sessions (id, token_hash, csrf, device_name, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    sha256(session.token),
    session.csrf,
    deviceName.slice(0, 100),
    now,
    now,
    now + SESSION_IDLE_MS,
  );
  return session;
}

/** Returns the session and slides its expiry, or undefined if unknown, revoked or expired. */
export function validateSession(
  db: Db,
  token: string,
  now = Date.now(),
): { id: string; csrf: string; deviceName: string } | undefined {
  const row = db
    .prepare(
      `SELECT id, csrf, device_name, created_at FROM sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(sha256(token), now);
  if (!row) return undefined;
  const createdAt = Number(row.created_at);
  if (now > createdAt + SESSION_MAX_AGE_MS) return undefined;
  db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(
    now,
    Math.min(now + SESSION_IDLE_MS, createdAt + SESSION_MAX_AGE_MS),
    row.id as string,
  );
  return { id: row.id as string, csrf: row.csrf as string, deviceName: row.device_name as string };
}

export function listSessions(db: Db, now = Date.now()): SessionInfo[] {
  return db
    .prepare(
      `SELECT id, device_name, created_at, last_seen_at, expires_at FROM sessions
       WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at`,
    )
    .all(now)
    .map((r) => ({
      id: r.id as string,
      deviceName: r.device_name as string,
      createdAt: Number(r.created_at),
      lastSeenAt: Number(r.last_seen_at),
      expiresAt: Number(r.expires_at),
    }));
}

export function revokeSession(db: Db, id: string, now = Date.now()): boolean {
  const r = db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(now, id);
  return r.changes === 1;
}
