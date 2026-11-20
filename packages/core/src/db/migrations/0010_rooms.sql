-- Agent rooms (ADR-0032): a room is a hidden thread (kind 'room') plus its turn order.
ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'room'));

CREATE TABLE rooms (
  id              TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  opener_task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  opener_agent_id TEXT NOT NULL,
  topic           TEXT NOT NULL,
  question        TEXT NOT NULL,
  participants    TEXT NOT NULL,          -- JSON array, speaking order
  rounds          INTEGER NOT NULL,
  turns_done      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  closed_at       INTEGER
);
CREATE INDEX rooms_opener ON rooms(opener_task_id);

ALTER TABLE tasks ADD COLUMN room_id TEXT REFERENCES rooms(id);
