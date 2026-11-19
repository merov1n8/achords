-- Schema v1. Timestamps are Unix epoch milliseconds. IDs are UUIDs.

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  workspace TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  workspace TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
  author TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram', 'system')),
  content TEXT NOT NULL,
  -- 'trace' = tool calls and intermediate steps, hidden by default (quiet output, ADR-0013).
  visibility TEXT NOT NULL DEFAULT 'normal' CHECK (visibility IN ('normal', 'trace')),
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_thread ON messages (thread_id, created_at);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  assignee_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  claimed_by TEXT,
  lease_until INTEGER,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX tasks_claimable ON tasks (status, priority DESC, created_at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  -- pid/pgid let `achords kill` terminate whole process groups without a live gateway.
  pid INTEGER,
  pgid INTEGER,
  exit_code INTEGER,
  usage_json TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX runs_status ON runs (status);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
