-- Planned stop (`achords stop`): an interrupted task continues from a note; the run keeps the
-- agent's checklist items so the note can list what was done.
ALTER TABLE tasks ADD COLUMN resume_note TEXT;
ALTER TABLE runs ADD COLUMN progress_items TEXT;
