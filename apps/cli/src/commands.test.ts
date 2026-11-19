import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreDatabase, redeemPairingCode } from "@achords/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = new URL("./index.ts", import.meta.url).pathname;

describe("achords CLI: pair and secret", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "achords-cli-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
      env: { ...process.env, ACHORDS_HOME: home, ACHORDS_KEYSTORE: "file" },
      input: input ?? "",
      encoding: "utf8",
    });

  it("pair web prints a working one-time code", () => {
    const out = run(["pair", "web"]);
    expect(out.status).toBe(0);
    const code = /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(out.stdout)?.[1] as string;
    const db = openCoreDatabase(join(home, "core.db"));
    expect(redeemPairingCode(db, "web", code)).toBe(true);
    db.close();
  });

  it("secret set reads the value from stdin (never argv) and list never shows it", () => {
    const value = "123456789:AAH-AbCdEfGhIjKlMnOpQrStUvWxYz01234";
    expect(run(["secret", "set", "telegram.bot-token"], `${value}\n`).status).toBe(0);
    const list = run(["secret", "list"]);
    expect(list.stdout).toContain("telegram.bot-token");
    expect(list.stdout).toContain("…1234");
    expect(list.stdout).not.toContain(value.slice(0, 15));
    expect(run(["secret", "rm", "telegram.bot-token"]).status).toBe(0);
    expect(run(["secret", "list"]).stdout).not.toContain("telegram.bot-token");
  });

  it("refuses an empty secret and a bad id", () => {
    expect(run(["secret", "set", "x.key"], "\n").status).toBe(1);
    expect(run(["secret", "set", "BAD ID"], "value-123\n").status).toBe(1);
  });
});
