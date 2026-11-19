-- Kanban workflow (ADR-0030): the card's column, and an audit log of every move.
-- NULL column = no card (child tasks and helpers are shown inside their root task's card).
ALTER TABLE tasks ADD COLUMN board_column TEXT;
UPDATE tasks SET board_column = CASE status WHEN 'done' THEN 'done' ELSE 'in_progress' END
  WHERE parent_id IS NULL;

CREATE TABLE task_moves (
  id          INTEGER PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_column TEXT,
  to_column   TEXT NOT NULL,
  actor       TEXT NOT NULL,              -- owner | agent:<id> | system
  override    INTEGER NOT NULL DEFAULT 0, -- owner move that no workflow rule grants
  created_at  INTEGER NOT NULL
);
CREATE INDEX task_moves_task ON task_moves(task_id, id);
