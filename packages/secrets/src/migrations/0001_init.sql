-- Vault schema v1 (separate file from core.db). Timestamps are Unix epoch milliseconds.

CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  -- value sealed with a per-secret data key; the data key sealed with the master key.
  value BLOB NOT NULL,
  dek BLOB NOT NULL,
  -- Shown in the UI; only kept for values long enough that 4 chars reveal little.
  last4 TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  secret_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('set', 'delete', 'resolve')),
  actor TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX audit_secret ON audit (secret_id, at);
