-- ADR-0063: one Telegram topic per chat while the bot's forum topic mode is on. A row exists
-- only while the topic does: an idle topic is deleted and made again when the chat moves.
CREATE TABLE telegram_topics (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  topic_id  INTEGER NOT NULL UNIQUE,
  active_at INTEGER NOT NULL
);
