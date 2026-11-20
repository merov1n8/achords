-- Scheduler (Phase 2 step 7, ADR-0033): cron-style schedules in local time.
CREATE TABLE schedules (
  id           TEXT PRIMARY KEY,
  seed_id      TEXT UNIQUE,           -- shipped schedules are seeded once by this id
  name         TEXT NOT NULL,
  cron         TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  instructions TEXT NOT NULL,
  project      TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  next_run_at  INTEGER NOT NULL,
  thread_id    TEXT REFERENCES threads(id) ON DELETE SET NULL,  -- where results are reported
  last_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  last_run_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX schedules_due ON schedules(enabled, next_run_at);
