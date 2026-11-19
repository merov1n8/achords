// Secrets vault, broker, redaction (ADR-0012).
export const PACKAGE_NAME = "@achords/secrets";

export { open, seal } from "./crypto.ts";
export {
  fileKeyStore,
  type KeyStore,
  keychainKeyStore,
  loadOrCreateMasterKey,
} from "./masterkey.ts";
export { createRedactor, REDACTED } from "./redact.ts";
export { type AuditEntry, openVault, type SecretStatus, type Vault } from "./vault.ts";
