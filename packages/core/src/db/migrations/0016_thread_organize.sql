-- Many chats (owner request): pin, archive (hide, restorable), delete.
ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
CREATE INDEX threads_list ON threads(kind, archived, updated_at);
