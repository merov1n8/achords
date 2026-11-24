-- ADR-0066 part 3: a delegated task asks its parent (ask_parent). waiting_parent is 1 while the
-- question is open and wakes the parent, 2 once a parent run saw it and ended without answering
-- (still open, but it no longer wakes the parent). parent_questions counts the task's questions.
ALTER TABLE tasks ADD COLUMN waiting_parent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN parent_question TEXT;
ALTER TABLE tasks ADD COLUMN parent_answer TEXT;
ALTER TABLE tasks ADD COLUMN parent_questions INTEGER NOT NULL DEFAULT 0;
