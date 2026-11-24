-- ADR-0067: a leveled agent whose run would hold both the open web and account tools works in
-- one of two halves per task, 'accounts' (the default) or 'web'; a handoff to itself switches.
ALTER TABLE tasks ADD COLUMN run_mode TEXT;
