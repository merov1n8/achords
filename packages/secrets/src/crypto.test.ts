import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { open, seal } from "./crypto.ts";

describe("seal/open (AES-256-GCM)", () => {
  const key = randomBytes(32);

  it("round-trips and uses a fresh IV each time", () => {
    const a = seal(key, Buffer.from("hello"), "aad");
    const b = seal(key, Buffer.from("hello"), "aad");
    expect(a.equals(b)).toBe(false);
    expect(open(key, a, "aad").toString()).toBe("hello");
  });

  it("rejects tampering, a wrong AAD and a wrong key", () => {
    const sealed = seal(key, Buffer.from("hello"), "aad");
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(() => open(key, tampered, "aad")).toThrow();
    expect(() => open(key, sealed, "other")).toThrow();
    expect(() => open(randomBytes(32), sealed, "aad")).toThrow();
  });

  it("refuses keys that are not 256-bit", () => {
    expect(() => seal(randomBytes(16), Buffer.from("x"), "a")).toThrow(/32 bytes/);
  });
});
