import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPairingCode,
  createSession,
  createThread,
  enqueue,
  homePaths,
  isPaused,
  listSessions,
  listThreads,
  openCoreDatabase,
} from "@achords/core";
import { openHomeVault } from "@achords/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArchive, exportHome, importHome, readArchive } from "./transfer.ts";

const PASS = "correct horse battery staple";
const ENV = { ACHORDS_KEYSTORE: "file" };

describe("export / import", () => {
  let root: string;
  let a: string;
  let b: string;
  let archive: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "achords-xfer-"));
    a = join(root, "machine-a");
    b = join(root, "machine-b");
    archive = join(root, "backup.achords");

    // Machine A: data, an agent manifest with absolute paths, a workspace file, secrets.
    mkdirSync(join(a, "agents", "web-dev"), { recursive: true });
    writeFileSync(
      join(a, "agents", "web-dev", "agent.yaml"),
      `fs:\n  write: ["${a}/workspaces/web-clients"]\n`,
    );
    mkdirSync(join(a, "workspaces", "web-clients", "acme"), { recursive: true });
    writeFileSync(join(a, "workspaces", "web-clients", "acme", "index.html"), "<h1>acme</h1>");
    mkdirSync(join(a, "run"), { recursive: true });
    // Any runtime file; not a pidfile, since a real PID there could belong to a live process.
    writeFileSync(join(a, "run", "scratch.tmp"), "runtime");
    mkdirSync(join(a, "logs"));
    writeFileSync(join(a, "logs", "gateway.log"), "log");
    const db = openCoreDatabase(join(a, "core.db"));
    createThread(db, { title: "Acme" });
    enqueue(db, { title: "card" });
    createSession(db, "MacBook");
    createPairingCode(db, "web");
    db.close();
    const v = openHomeVault(a, ENV);
    v.set("telegram.bot-token", "123456789:AAH-TransferTokenTransferToken01", "test");
    v.close();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("round-trips data, workspaces and secrets to a new machine", () => {
    const summary = exportHome(a, archive, PASS, ENV);
    expect(summary.secrets).toBe(1);
    expect(statSync(archive).mode & 0o777).toBe(0o600);

    importHome(b, archive, PASS, ENV);
    expect(readFileSync(join(b, "workspaces", "web-clients", "acme", "index.html"), "utf8")).toBe(
      "<h1>acme</h1>",
    );
    const db = openCoreDatabase(join(b, "core.db"));
    expect(listThreads(db).map((t) => t.title)).toEqual(["Acme"]);
    // Web sessions and open pairing codes do not travel; the queue starts paused.
    expect(listSessions(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pairing_codes").get()?.n).toBe(0);
    expect(isPaused(db)).toBe(true);
    db.close();

    const v = openHomeVault(b, ENV);
    expect(v.resolve("telegram.bot-token", "test")).toBe(
      "123456789:AAH-TransferTokenTransferToken01",
    );
    v.close();
  });

  it("rewrites the old data path in agent manifests", () => {
    exportHome(a, archive, PASS, ENV);
    importHome(b, archive, PASS, ENV);
    const yaml = readFileSync(join(b, "agents", "web-dev", "agent.yaml"), "utf8");
    expect(yaml).toContain(`${b}/workspaces/web-clients`);
    expect(yaml).not.toContain(a);
  });

  it("leaves out runtime files, logs, the old vault and the old master key", () => {
    exportHome(a, archive, PASS, ENV);
    const { files } = readArchive(readFileSync(archive), PASS);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("core.db");
    expect(paths.some((p) => p.startsWith("run/") || p.startsWith("logs/"))).toBe(false);
    expect(paths).not.toContain("vault.db");
    expect(paths).not.toContain("master.key");
  });

  it("encrypts everything: no plaintext secret or file content in the archive", () => {
    exportHome(a, archive, PASS, ENV);
    const bytes = readFileSync(archive);
    expect(bytes.includes(Buffer.from("TransferToken"))).toBe(false);
    expect(bytes.includes(Buffer.from("acme"))).toBe(false);
  });

  it("rejects a wrong passphrase and any tampering", () => {
    exportHome(a, archive, PASS, ENV);
    expect(() => importHome(b, archive, "wrong passphrase!!", ENV)).toThrow(/passphrase|corrupt/);
    const bytes = readFileSync(archive);
    bytes[bytes.length - 5] = (bytes.at(-5) ?? 0) ^ 1;
    writeFileSync(archive, bytes);
    expect(() => importHome(b, archive, PASS, ENV)).toThrow(/passphrase|corrupt/);
    expect(existsSync(join(b, "core.db"))).toBe(false);
  });

  it("refuses to import over an existing install", () => {
    exportHome(a, archive, PASS, ENV);
    expect(() => importHome(a, archive, PASS, ENV)).toThrow(/already/);
  });

  it("refuses archive entries that would escape the target folder", () => {
    const evil = buildArchive(
      {
        version: 1,
        sourceHome: "/x",
        createdAt: 0,
        files: [{ path: "../evil.txt", mode: 0o600, data: "eA==" }],
        secrets: [],
      },
      PASS,
    );
    writeFileSync(archive, evil);
    expect(() => importHome(b, archive, PASS, ENV)).toThrow(/unsafe path/);
    expect(existsSync(join(root, "evil.txt"))).toBe(false);
  });

  it("requires a strong passphrase and a stopped gateway", () => {
    expect(() => exportHome(a, archive, "short", ENV)).toThrow(/at least 12/);
    writeFileSync(join(a, "run", "gateway.pid"), String(process.pid));
    expect(() => exportHome(a, archive, PASS, ENV)).toThrow(/stop the gateway/);
  });

  it("pauses the source queue after export (only one machine should work)", () => {
    exportHome(a, archive, PASS, ENV);
    const db = openCoreDatabase(homePaths(a).db);
    expect(isPaused(db)).toBe(true);
    db.close();
  });
});
