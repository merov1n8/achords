-- Ephemeral workers and agent proposals (ADR-0029).
-- A worker task runs the caller's agent with a restricted spec: {"tools": [...], "paths": [...]}.
ALTER TABLE tasks ADD COLUMN worker_spec TEXT;

CREATE TABLE agent_proposals (
  id TEXT PRIMARY KEY,
  proposed_by TEXT NOT NULL,
  task_id TEXT,
  thread_id TEXT,
  agent_id TEXT NOT NULL,
  yaml TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
