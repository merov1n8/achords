import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where the vault's master key (KEK) lives. Stored as 64 hex chars. */
export interface KeyStore {
  readonly kind: string;
  get(): string | undefined;
  put(hex: string): void;
  remove(): void;
}

const HEX_KEY = /^[0-9a-f]{64}$/;

export function loadOrCreateMasterKey(store: KeyStore): Buffer {
  const existing = store.get();
  if (existing !== undefined) {
    // Never replace a bad key silently: that would orphan every stored secret.
    if (!HEX_KEY.test(existing)) throw new Error(`master key in ${store.kind} is malformed`);
    return Buffer.from(existing, "hex");
  }
  const key = randomBytes(32);
  store.put(key.toString("hex"));
  return key;
}

type SecurityRunner = (args: string[], input?: string) => string;

const runSecurity: SecurityRunner = (args, input) =>
  execFileSync("security", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "ignore"],
  });

/** macOS login Keychain via the `security` CLI. */
export function keychainKeyStore(
  service: string,
  account: string,
  security: SecurityRunner = runSecurity,
): KeyStore {
  // Both are interpolated into a `security -i` command line.
  for (const name of [service, account]) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid keychain name: ${name}`);
  }
  return {
    kind: "keychain",
    get() {
      try {
        return security(["find-generic-password", "-s", service, "-a", account, "-w"]).trim();
      } catch (err) {
        if ((err as { status?: number }).status === 44) return undefined; // item not found
        throw err;
      }
    },
    put(hex) {
      if (!HEX_KEY.test(hex)) throw new Error("refusing to store a malformed key");
      // `security -i` reads the command from stdin, so the key never appears in `ps` output.
      security(["-i"], `add-generic-password -U -s ${service} -a ${account} -w ${hex}\n`);
    },
    remove() {
      try {
        security(["delete-generic-password", "-s", service, "-a", account]);
      } catch (err) {
        if ((err as { status?: number }).status !== 44) throw err;
      }
    },
  };
}

/** Fallback for hosts without a Keychain (Linux). The file must stay 0600. */
export function fileKeyStore(path: string): KeyStore {
  return {
    kind: "file",
    get() {
      if (!existsSync(path)) return undefined;
      if ((statSync(path).mode & 0o077) !== 0) {
        throw new Error(`refusing ${path}: permissions must be 0600`);
      }
      return readFileSync(path, "utf8").trim();
    },
    put(hex) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${hex}\n`, { mode: 0o600, flag: "wx" });
    },
    remove() {
      rmSync(path, { force: true });
    },
  };
}
