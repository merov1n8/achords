import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileKeyStore, keychainKeyStore, loadOrCreateMasterKey } from "./masterkey.ts";

describe("fileKeyStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-key-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a 256-bit key once, mode 0600, and returns the same key afterwards", () => {
    const store = fileKeyStore(join(dir, "master.key"));
    const k1 = loadOrCreateMasterKey(store);
    const k2 = loadOrCreateMasterKey(store);
    expect(k1).toHaveLength(32);
    expect(k1.equals(k2)).toBe(true);
    expect(statSync(join(dir, "master.key")).mode & 0o777).toBe(0o600);
  });

  it("remove deletes the key file, so a new key can be created", () => {
    const path = join(dir, "master.key");
    const store = fileKeyStore(path);
    const k1 = loadOrCreateMasterKey(store);
    store.remove();
    expect(store.get()).toBeUndefined();
    expect(loadOrCreateMasterKey(store).equals(k1)).toBe(false);
  });

  it("refuses a key file readable by others", () => {
    const path = join(dir, "master.key");
    loadOrCreateMasterKey(fileKeyStore(path));
    chmodSync(path, 0o644);
    expect(() => loadOrCreateMasterKey(fileKeyStore(path))).toThrow(/permissions/);
  });
});

describe("keychainKeyStore", () => {
  function fakeSecurity(existing?: string) {
    const calls: { args: string[]; input?: string | undefined }[] = [];
    let stored = existing;
    const store = keychainKeyStore("svc", "acct", (args, input) => {
      calls.push({ args, input });
      if (args[0] === "find-generic-password") {
        if (stored === undefined) throw Object.assign(new Error("not found"), { status: 44 });
        return `${stored}\n`;
      }
      // `security -i` reads commands from stdin
      stored = /-w ([0-9a-f]+)/.exec(input ?? "")?.[1];
      return "";
    });
    return { store, calls };
  }

  it("never puts the key on the command line (visible in ps)", () => {
    const { store, calls } = fakeSecurity();
    const key = loadOrCreateMasterKey(store);
    const hex = key.toString("hex");
    for (const c of calls) expect(c.args.join(" ")).not.toContain(hex);
    expect(calls.some((c) => c.args[0] === "-i" && c.input?.includes(hex))).toBe(true);
    expect(loadOrCreateMasterKey(store).equals(key)).toBe(true);
  });

  it("rejects names that would break the security -i command line", () => {
    expect(() => keychainKeyStore("my service", "acct", () => "")).toThrow(/invalid keychain/);
  });

  it("reads an existing key", () => {
    const hex = "ab".repeat(32);
    const { store } = fakeSecurity(hex);
    expect(loadOrCreateMasterKey(store).toString("hex")).toBe(hex);
  });

  it("rejects a malformed stored key instead of silently replacing it", () => {
    const { store } = fakeSecurity("nothex");
    expect(() => loadOrCreateMasterKey(store)).toThrow(/malformed/);
  });
});

// Touches the real login keychain; run locally with ACHORDS_TEST_KEYCHAIN=1.
describe.runIf(process.platform === "darwin" && process.env.ACHORDS_TEST_KEYCHAIN === "1")(
  "keychainKeyStore (real Keychain)",
  () => {
    it("creates, reads back and deletes a test item", () => {
      const service = `achords-test-${process.pid}`;
      const store = keychainKeyStore(service, "master-key");
      try {
        const key = loadOrCreateMasterKey(store);
        expect(loadOrCreateMasterKey(keychainKeyStore(service, "master-key")).equals(key)).toBe(
          true,
        );
      } finally {
        store.remove();
      }
      expect(store.get()).toBeUndefined();
    });
  },
);
