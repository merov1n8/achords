-- ADR-0055 handoff: a step that continues the work of an earlier sibling (tail call), and the
-- handoff a running task asked for (created as the successor when its run ends well).
ALTER TABLE tasks ADD COLUMN continues_from TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN handoff TEXT;
