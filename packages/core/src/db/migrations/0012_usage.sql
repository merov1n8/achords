-- Usage meters (Phase 2 step 6): latest state of each subscription window per provider, as the
-- CLI reports it with every run (there is no quota endpoint to poll), and the cost per run.
CREATE TABLE usage_windows (
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- e.g. five_hour, seven_day
  utilization REAL NOT NULL,          -- 0..1
  resets_at   INTEGER NOT NULL,       -- epoch ms
  status      TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, kind)
);
ALTER TABLE runs ADD COLUMN cost_usd REAL;
