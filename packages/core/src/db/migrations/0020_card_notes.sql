-- Owner notes on kanban cards: an ordered checklist and append-only comments.
-- Both go with their task (a deleted card takes its notes along).
CREATE TABLE task_checklist (
  id         INTEGER PRIMARY KEY,         -- insertion order is the list order
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX task_checklist_task ON task_checklist(task_id, id);

CREATE TABLE task_comments (
  id         INTEGER PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX task_comments_task ON task_comments(task_id, id);
