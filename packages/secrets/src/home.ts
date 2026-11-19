import { mkdirSync } from "node:fs";
import { type HomePaths, homePaths } from "@achords/core";
import {
  fileKeyStore,
  type KeyStore,
  keychainKeyStore,
  loadOrCreateMasterKey,
} from "./masterkey.ts";
import { openVault, type Vault } from "./vault.ts";

const KEYCHAIN_SERVICE = "achords";
const KEYCHAIN_ACCOUNT = "master-key";

/** Keychain on macOS; 0600 file elsewhere, or anywhere with ACHORDS_KEYSTORE=file (CI, headless). */
export function defaultKeyStore(
  paths: HomePaths,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): KeyStore {
  if (env.ACHORDS_KEYSTORE !== "file" && platform === "darwin") {
    return keychainKeyStore(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  }
  return fileKeyStore(paths.masterKeyFile);
}

export function openHomeVault(home: string, env: NodeJS.ProcessEnv = process.env): Vault {
  const paths = homePaths(home);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  return openVault(paths.vaultDb, loadOrCreateMasterKey(defaultKeyStore(paths, env)));
}
