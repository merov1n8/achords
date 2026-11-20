-- Heartbeat monitors (Phase 3 step 5, ADR-0039): cheap periodic checks that notify the owner
-- only when their state changes.
CREATE TABLE monitors (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,          -- site | stuck
  config         TEXT NOT NULL,          -- JSON, per kind
  every_minutes  INTEGER NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  state          TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown', 'ok', 'alert')),
  detail         TEXT,                   -- what the last check found
  notified       INTEGER NOT NULL DEFAULT 1,  -- 0: a change is waiting for the owner
  next_check_at  INTEGER NOT NULL,
  last_check_at  INTEGER,
  last_change_at INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX monitors_due ON monitors(enabled, next_check_at);
