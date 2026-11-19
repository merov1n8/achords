import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@achords/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openVault } from "./vault.ts";

const VALUE = "sk-ant-api03-THIS-IS-A-TEST-VALUE-1234";

describe("vault", () => {
  let dir: string;
  let path: string;
  const key = randomBytes(32);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-vault-"));
    path = join(dir, "vault.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stores secrets write-only: status never carries the value", () => {
    const v = openVault(path, key);
    v.set("anthropic.api-key", VALUE, "owner", 10);
    const status = v.status("anthropic.api-key");
    expect(status).toEqual({ id: "anthropic.api-key", set: true, last4: "1234", updatedAt: 10 });
    expect(JSON.stringify(v.list())).not.toContain(VALUE.slice(0, 12));
    expect(v.status("missing")).toEqual({
      id: "missing",
      set: false,
      last4: null,
      updatedAt: null,
    });
    v.close();
  });

  it("hides last4 for short secrets", () => {
    const v = openVault(path, key);
    v.set("pin", "12345678", "owner");
    expect(v.status("pin").last4).toBeNull();
    v.close();
  });

  it("resolves values and vault: references for the broker, and audits every use", () => {
    const v = openVault(path, key);
    v.set("telegram.bot", VALUE, "owner", 1);
    expect(v.resolve("telegram.bot", "agent:boss", 2)).toBe(VALUE);
    expect(v.resolveRef("vault:telegram.bot", "gateway", 3)).toBe(VALUE);
    expect(() => v.resolve("nope", "agent:boss")).toThrow(/not set/);
    expect(() => v.resolveRef("telegram.bot", "gateway")).toThrow(/vault:/);
    expect(v.audit("telegram.bot")).toEqual([
      { secretId: "telegram.bot", action: "set", actor: "owner", at: 1 },
      { secretId: "telegram.bot", action: "resolve", actor: "agent:boss", at: 2 },
      { secretId: "telegram.bot", action: "resolve", actor: "gateway", at: 3 },
    ]);
    v.close();
  });

  it("overwrites and deletes", () => {
    const v = openVault(path, key);
    v.set("x.key", VALUE, "owner", 1);
    v.set("x.key", `${VALUE}-new-5678`, "owner", 2);
    expect(v.status("x.key")).toMatchObject({ last4: "5678", updatedAt: 2 });
    expect(v.delete("x.key", "owner")).toBe(true);
    expect(v.delete("x.key", "owner")).toBe(false);
    expect(v.status("x.key").set).toBe(false);
    v.close();
  });

  it("validates ids", () => {
    const v = openVault(path, key);
    for (const bad of ["", "UPPER", "has space", "../x", "a".repeat(65)]) {
      expect(() => v.set(bad, VALUE, "owner")).toThrow(/invalid secret id/);
    }
    v.close();
  });

  it("never writes the plaintext to disk", () => {
    const v = openVault(path, key);
    v.set("x.key", VALUE, "owner");
    v.close();
    for (const f of [path, `${path}-wal`]) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(f);
      } catch {
        continue;
      }
      expect(bytes.includes(Buffer.from(VALUE))).toBe(false);
    }
  });

  it("cannot be read with another master key, nor by swapping rows", () => {
    const v = openVault(path, key);
    v.set("a.key", VALUE, "owner");
    v.set("b.key", "another-secret-value-9999", "owner");
    v.close();

    const other = openVault(path, randomBytes(32));
    expect(() => other.resolve("a.key", "x")).toThrow();
    other.close();

    // Copy b's ciphertext into a's row: AAD binds ciphertext to its id, so this must fail.
    const db = openDatabase(path);
    db.exec(
      "UPDATE secrets SET value = (SELECT value FROM secrets WHERE id = 'b.key'), dek = (SELECT dek FROM secrets WHERE id = 'b.key') WHERE id = 'a.key'",
    );
    db.close();
    const v2 = openVault(path, key);
    expect(() => v2.resolve("a.key", "x")).toThrow();
    v2.close();
  });

  it("builds a redactor from all stored values", () => {
    const v = openVault(path, key);
    v.set("x.key", "plain-looking-secret-abc", "owner");
    const redact = v.redactor();
    expect(redact("token is plain-looking-secret-abc ok")).toBe("token is [REDACTED] ok");
    v.close();
  });
});
