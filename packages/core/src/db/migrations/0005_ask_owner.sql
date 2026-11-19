-- ask_owner (ADR-0029): a task waits for the owner's answer, which is routed back to it.
ALTER TABLE tasks ADD COLUMN waiting_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN owner_question TEXT;
ALTER TABLE tasks ADD COLUMN owner_answer TEXT;
