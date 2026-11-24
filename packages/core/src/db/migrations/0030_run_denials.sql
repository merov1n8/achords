-- Tool calls a run's CLI refused (permission not granted, needs approval, blocked by the sandbox):
-- a JSON array of {tool, input, reason, unsandboxed?}, already redacted. NULL when there were none.
ALTER TABLE runs ADD COLUMN denials TEXT;
