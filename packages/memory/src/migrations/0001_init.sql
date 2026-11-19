-- Long-term memory (ADR-0008). The vec0 table is created at open time (needs the dimension).

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'summary', 'note')),
  content TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL,
  -- 0 while the embedding model was unavailable; backfilled later.
  has_vec INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX memories_workspace ON memories (workspace, created_at);

CREATE VIRTUAL TABLE memories_fts USING fts5(content, content = 'memories', content_rowid = 'id');
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
