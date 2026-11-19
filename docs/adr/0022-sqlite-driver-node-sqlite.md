# ADR-0022: SQLite driver is `node:sqlite`

Status: Accepted (2026-11-19)

- Context: Core needs a synchronous SQLite driver with FTS5 and extension loading (`sqlite-vec`, ADR-0008). Candidates: `better-sqlite3` (mature, native addon) and the built-in `node:sqlite` (Node 22.13+).
- Decision: Use `node:sqlite`. No native build step on install (simpler `achords init` on customer Macs), no extra dependency. Verified on Node 22.23: FTS5 available, `loadExtension` supported (`allowExtension: true`), bundled SQLite 3.54.
- Consequences: The module is still flagged experimental and prints an `ExperimentalWarning`; the API may change between Node majors, so access stays behind `packages/core/src/db/`. Fallback is `better-sqlite3`, whose sync API is close enough to swap in that module. Connection setup: `busy_timeout` first, WAL (with retry for concurrent first-open), `foreign_keys = ON`; migrations run in one `BEGIN IMMEDIATE` transaction.
