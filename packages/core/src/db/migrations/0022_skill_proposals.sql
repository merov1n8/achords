-- Skill proposals from agents (ADR-0049). Skills themselves are Markdown files in
-- $ACHORDS_HOME/skills; a row records a proposal and how it was decided.
CREATE TABLE skill_proposals (
  id TEXT PRIMARY KEY,
  proposed_by TEXT NOT NULL,
  task_id TEXT,
  thread_id TEXT,
  -- Where the skill file goes (for a change: the workspace of the skill it replaces).
  workspace TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  reason TEXT NOT NULL,
  replaces TEXT,
  source_url TEXT,
  -- Hash of the replaced file when proposed: approval refuses if it changed since.
  base_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
