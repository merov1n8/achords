import { describe, expect, it } from "vitest";
import { createRedactor } from "./redact.ts";

const R = "[REDACTED]";
// Fake fixture, split from its use so the allow marker stays on the same line.
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"; // gitleaks:allow

describe("createRedactor", () => {
  it("redacts known values, longest first, everywhere they occur", () => {
    const redact = createRedactor(["supersecret-1", "supersecret-1-long"]);
    expect(redact("a supersecret-1-long b supersecret-1 c")).toBe(`a ${R} b ${R} c`);
  });

  it("ignores very short known values (they would shred normal text)", () => {
    expect(createRedactor(["abc"])("abc def")).toBe("abc def");
  });

  it.each([
    ["anthropic", "key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
    ["openai", "OPENAI sk-proj-AbCdEfGhIjKlMnOpQrStUvWx"],
    ["github", "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
    ["github fine-grained", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"],
    ["aws", "AKIAIOSFODNN7EXAMPLE"],
    ["google", "AIzaSyA-AbCdEfGhIjKlMnOpQrStUvWxYz01234"],
    ["slack", "xoxb-123456789012-123456789012-AbCdEfGhIjKl"], // gitleaks:allow (fake test fixture)
    ["telegram", "123456789:AAH-AbCdEfGhIjKlMnOpQrStUvWxYz01234"],
    ["jwt", FAKE_JWT],
    ["bearer", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"],
  ])("redacts %s patterns", (_name, text) => {
    const out = createRedactor([])(text);
    expect(out).toContain(R);
    // Nothing that looks like the credential body survives.
    expect(out).not.toMatch(/[A-Za-z0-9_-]{20,}/);
  });

  it("redacts private key blocks", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----";
    expect(createRedactor([])(`x ${pem} y`)).toBe(`x ${R} y`);
  });

  it("redacts values of key=value style assignments, keeping the key name", () => {
    const redact = createRedactor([]);
    expect(redact('api_key="hunter2hunter2"')).toBe(`api_key="${R}"`);
    expect(redact("PASSWORD: correct-horse-battery")).toBe(`PASSWORD: ${R}`);
  });

  it("leaves ordinary text alone", () => {
    const text = "Deployed build 1234 to staging; see https://example.com/docs?page=2";
    expect(createRedactor([])(text)).toBe(text);
  });
});
