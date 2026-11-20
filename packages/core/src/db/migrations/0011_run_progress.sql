-- Live run progress (Phase 2 step 5b): the agent's own checklist, latest state per run.
ALTER TABLE runs ADD COLUMN progress_done INTEGER;
ALTER TABLE runs ADD COLUMN progress_total INTEGER;
ALTER TABLE runs ADD COLUMN progress_label TEXT;
ALTER TABLE runs ADD COLUMN progress_at INTEGER;
