import { describe, expect, it } from "vitest";
import {
  AuthError,
  createPairingCode,
  createSession,
  listSessions,
  redeemPairingCode,
  revokeSession,
  validateSession,
} from "./auth.ts";
import { openCoreDatabase } from "./db/database.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("pairing codes", () => {
  it("are single-use and expire after 10 minutes", () => {
    const db = openCoreDatabase(":memory:");
    const code = createPairingCode(db, "web", 0);
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(redeemPairingCode(db, "web", code, 1)).toBe(true);
    expect(() => redeemPairingCode(db, "web", code, 2)).toThrow(AuthError);

    const late = createPairingCode(db, "web", 0);
    expect(() => redeemPairingCode(db, "web", late, 10 * MIN + 1)).toThrow(/invalid or expired/);
  });

  it("are bound to their purpose and tolerate case and dash differences", () => {
    const db = openCoreDatabase(":memory:");
    const code = createPairingCode(db, "telegram", 0);
    expect(() => redeemPairingCode(db, "web", code, 1)).toThrow(AuthError);
    expect(redeemPairingCode(db, "telegram", code.toLowerCase().replace("-", ""), 2)).toBe(true);
  });

  it("locks out after 5 failures in 15 minutes and burns outstanding codes", () => {
    const db = openCoreDatabase(":memory:");
    const code = createPairingCode(db, "web", 0);
    for (let i = 0; i < 5; i++) {
      expect(() => redeemPairingCode(db, "web", "WRONG-CODE", i)).toThrow(/invalid/);
    }
    // Even the right code is refused now, and stays burned after the lockout ends.
    expect(() => redeemPairingCode(db, "web", code, 10)).toThrow(/too many attempts/);
    expect(() => redeemPairingCode(db, "web", code, 16 * MIN)).toThrow(/invalid/);
    const fresh = createPairingCode(db, "web", 16 * MIN);
    expect(redeemPairingCode(db, "web", fresh, 16 * MIN + 1)).toBe(true);
  });
});

describe("sessions", () => {
  it("validate by token, renew on use (sliding), and expire when idle", () => {
    const db = openCoreDatabase(":memory:");
    const s = createSession(db, "MacBook Safari", 0);
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(validateSession(db, s.token, 13 * DAY)).toMatchObject({ id: s.id, csrf: s.csrf });
    // Renewed at day 13, so still valid at day 26.
    expect(validateSession(db, s.token, 26 * DAY)).toBeDefined();
    expect(validateSession(db, s.token, 41 * DAY)).toBeUndefined();
    expect(validateSession(db, "nope", 1)).toBeUndefined();
  });

  it("have an absolute maximum age despite renewal", () => {
    const db = openCoreDatabase(":memory:");
    const s = createSession(db, "d", 0);
    for (let day = 10; day < 90; day += 10)
      expect(validateSession(db, s.token, day * DAY)).toBeDefined();
    expect(validateSession(db, s.token, 90 * DAY + 1)).toBeUndefined();
  });

  it("can be listed (without secrets) and revoked per device", () => {
    const db = openCoreDatabase(":memory:");
    const a = createSession(db, "MacBook", 1);
    const b = createSession(db, "iPhone", 2);
    const list = listSessions(db, 3);
    expect(list.map((d) => d.deviceName)).toEqual(["MacBook", "iPhone"]);
    expect(JSON.stringify(list)).not.toContain(a.token);
    expect(JSON.stringify(list)).not.toContain(a.csrf);
    expect(revokeSession(db, b.id, 4)).toBe(true);
    expect(validateSession(db, b.token, 5)).toBeUndefined();
    expect(validateSession(db, a.token, 5)).toBeDefined();
    expect(listSessions(db, 6).map((d) => d.id)).toEqual([a.id]);
  });
});
