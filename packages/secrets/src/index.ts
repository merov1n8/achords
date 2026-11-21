// Secrets vault, broker, redaction (ADR-0012).
export const PACKAGE_NAME = "@achords/secrets";

export { open, seal } from "./crypto.ts";
export {
  createGoogleSignins,
  GOOGLE_SCOPES,
  GOOGLE_VAULT_IDS,
  type GoogleClient,
  type GoogleSignins,
  parseClientJson,
  type SigninState,
} from "./google-oauth.ts";
export { defaultKeyStore, openHomeVault } from "./home.ts";
export {
  fileKeyStore,
  type KeyStore,
  keychainKeyStore,
  loadOrCreateMasterKey,
} from "./masterkey.ts";
export { createRedactor, REDACTED } from "./redact.ts";
export { type AuditEntry, openVault, type SecretStatus, type Vault } from "./vault.ts";
