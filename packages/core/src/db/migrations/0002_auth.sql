-- Web sessions and pairing codes. Only hashes of codes and session tokens are stored.

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- public device id (shown in the UI, used to revoke)
  token_hash TEXT NOT NULL UNIQUE,   -- sha256 of the cookie value
  csrf TEXT NOT NULL,                -- per-session anti-CSRF token (sent back in a header)
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,       -- sliding: renewed on use, capped by created_at + max age
  revoked_at INTEGER
);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('web', 'telegram')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE auth_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX auth_failures_purpose ON auth_failures (purpose, at);
