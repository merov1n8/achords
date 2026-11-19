import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, homePaths, openCoreDatabase, redeemPairingCode } from "@achords/core";
import { openVault, type Vault } from "@achords/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Check } from "./doctor.ts";
import { type InitDeps, runInit } from "./init.ts";

describe("achords init", () => {
  let root: string;
  let vault: Vault;
  let out: string[];
  let started: number;
  const key = randomBytes(32);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "achords-init-"));
    // The test keeps its own handle; init opens (and closes) separate ones on the same file.
    vault = openVault(join(root, "vault.db"), key);
    out = [];
    started = 0;
  });
  afterEach(() => {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  });

  const deps = (answers: string[], checks: Check[] = []): InitDeps => {
    const queue = [...answers];
    return {
      paths: homePaths(join(root, "home")),
      io: {
        ask: async (q) => {
          out.push(`? ${q}`);
          return queue.shift() ?? "";
        },
        print: (line) => out.push(line),
      },
      doctor: async () => checks,
      openVault: () => openVault(join(root, "vault.db"), key),
      start: () => {
        started++;
        return "gateway started (fake)";
      },
    };
  };

  const codes = () => out.join("\n").match(/[A-Z2-9]{4}-[A-Z2-9]{4}/g) ?? [];

  it("sets up the data folder, Telegram token, service and pairing codes", async () => {
    const d = deps(["y", "123456789:AAH-TestTokenTestTokenTestToken0123"]);
    expect(await runInit(d)).toBe(0);
    expect(statSync(d.paths.home).mode & 0o777).toBe(0o700);
    expect(vault.status("telegram.bot-token")).toMatchObject({ set: true, last4: "0123" });
    expect(started).toBe(1);
    // The token never appears in output.
    expect(out.join("\n")).not.toContain("TestToken");

    const db = openCoreDatabase(d.paths.db);
    expect(getSetting(db, "providers.mode")).toBe("cli");
    const [telegram, web] = codes();
    expect(redeemPairingCode(db, "telegram", telegram as string)).toBe(true);
    expect(redeemPairingCode(db, "web", web as string)).toBe(true);
    db.close();
    expect(out.join("\n")).toContain("http://127.0.0.1:7420");
  });

  it("skips Telegram when declined", async () => {
    expect(await runInit(deps(["n"]))).toBe(0);
    expect(vault.status("telegram.bot-token").set).toBe(false);
    expect(codes()).toHaveLength(1); // web only
  });

  it("is re-runnable: keeps an existing token unless asked to replace it", async () => {
    vault.set("telegram.bot-token", "old-token-value-1111", "test");
    expect(await runInit(deps(["n"]))).toBe(0);
    expect(vault.status("telegram.bot-token").last4).toBe("1111");
    expect(out.join("\n")).toMatch(/already set/);
  });

  it("stops before changing anything when doctor reports a failure", async () => {
    const d = deps(
      [],
      [{ name: "claude CLI", level: "fail", detail: "missing", fix: "install it" }],
    );
    expect(await runInit(d)).toBe(1);
    expect(started).toBe(0);
    expect(out.join("\n")).toMatch(/claude CLI.*install it/s);
  });

  it("finishes with guidance if the service cannot start", async () => {
    const d = deps(["n"]);
    d.start = () => {
      throw new Error("gateway did not start within 5s");
    };
    expect(await runInit(d)).toBe(1);
    expect(out.join("\n")).toMatch(/did not start/);
  });
});
