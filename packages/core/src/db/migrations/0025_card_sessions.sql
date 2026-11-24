-- ADR-0066 part 5: one CLI session per agent and card. `card` is the card's task id; it moves
-- with the card when the next task of the chat takes it over. `project` is '' without one.
CREATE TABLE card_sessions (
  card         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent        TEXT NOT NULL,
  project      TEXT NOT NULL DEFAULT '',
  session_id   TEXT NOT NULL,
  model        TEXT NOT NULL,
  trust        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (card, agent, project)
);
-- The run details show what a resumed run read (cached and uncached).
ALTER TABLE runs ADD COLUMN resumed INTEGER NOT NULL DEFAULT 0;
