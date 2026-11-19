# ADR-0008: Memory = SQLite (FTS5 + sqlite-vec) + Obsidian-compatible MD vault

Status: Accepted (2026-11-19)

- Decision: Hybrid search with RRF, tiered memory with salience decay, local embeddings only.
- Consequences: No separate vector DB service; single-file backups.
