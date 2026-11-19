-- Memories from local-only work (ADR-0007) must never be put into a frontier model's prompt.
ALTER TABLE memories ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0;
