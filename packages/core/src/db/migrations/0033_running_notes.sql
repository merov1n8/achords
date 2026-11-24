-- ADR-0069: notes to running work. A note is a card comment sent to a running task; a request
-- result is the outcome of an owner-approved request. delivered_at: when the agent got it.
ALTER TABLE task_comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment';
ALTER TABLE task_comments ADD COLUMN for_task TEXT;
ALTER TABLE task_comments ADD COLUMN delivered_at INTEGER;
