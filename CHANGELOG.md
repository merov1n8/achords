# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- Memory ranking for Hungarian: multilingual `bge-m3` is the default embedding model (`nomic-embed-text` scored like no embeddings at all), weighted fusion, and dissimilar vector hits no longer earn rank points.

- Memory keyword search matches Hungarian suffixed word forms (trigram index): "WordPresst" finds "WordPress", "Kovácséknak" finds "Kovács".

- Gateway service could not find the `claude` CLI (`spawn claude ENOENT`): launchd/systemd jobs now get the PATH of the shell that ran `achords start`; `achords doctor` checks the installed service's PATH.

### Changed

- Sub-agents write their final report in the language the owner uses with the boss.

### Added

- Hub MCP server with the `delegate` tool: agents allowed to delegate get it through a private per-run config file and a run token (revoked after the run); verified with the real `claude` CLI (planner → writer → planner resumes with the result, only the final result posted). A child that dies with its worker now still wakes its parent.

- Inter-agent delegation core (ADR-0029): linked parent/child tasks, `delegation.can_delegate_to` / `accepts_from` (deny by default, boss to all), max depth 3, cycle refusal, fan-out limit 5, one budget per chain, local-only propagation, results flow back to the delegating agent, only the root result reaches the owner. The boss's delegation now uses it.

- Sensitivity routing (ADR-0007): local-only threads and tasks run only on local models, never fall back to a frontier model; a task whose local server is down waits and retries; local-only memories never reach a frontier prompt; Telegram `/local` and `POST /api/threads {sensitivity}`; the seeded boss allows `local/qwen3:8b`.

- Long-term memory (`packages/memory`): FTS5 + sqlite-vec hybrid search (RRF) with local Ollama embeddings, keyword-only fallback and backfill; the boss and sub-agents get relevant memories, finished tasks are remembered (redacted). New dependency: `sqlite-vec` 0.1.9 (ADR-0008).

- Local models: `local` provider for Ollama / OpenAI-compatible servers (keep-alive TTL, structured output, timeout/cancel; refuses tool runs), platform detection with model recommendation by RAM, `achords doctor` checks Ollama and the recommended models.

- Phase 0 scaffold: pnpm monorepo (`apps/*`, `packages/*`), TypeScript strict config, Biome, Vitest.
- CI on Linux and macOS, gitleaks secret scanning (CI and pre-commit hook).
- Architecture document and ADR-0001 to ADR-0020.
- Apache-2.0 license, README, CONTRIBUTING (CLA), SECURITY policy.
- Core: SQLite store (`node:sqlite`) with migrations runner and schema v1 (threads, messages, tasks, agents, runs, settings); thread/message model; lease-based task queue with retries, crash recovery and pause flag; `ACHORDS_HOME` data root.
- ADR-0022: SQLite driver is `node:sqlite`.
- Control CLI (`pnpm achords start|stop|status|kill|resume`): gateway as a launchd service; emergency stop that kills the gateway and agent process groups, pauses the queue and blocks restarts until `resume`. See `docs/OPERATIONS.md`.
- Secrets vault (`packages/secrets`): Keychain/file master key, per-secret AES-256-GCM envelope encryption in `vault.db`, write-only status API, `vault:<id>` resolver, audit log, redaction filter (known values + common credential patterns).
- Policy engine (`packages/policy`): strict `agent.yaml` schema and loader; deny-by-default checks for tools, MCP servers, models (local-only routing, fail-closed), filesystem (symlink-safe), shell (allow-list or approval), network and publish mode. ADR-0023: `yaml` + `zod`.
- Providers (`packages/providers`): `ModelProvider` interface; `cli-claude` adapter for the official CLI (stream-json, locked-down flags, timeout/cancel with process-group kill, usage and cost); subscription and API usage meters. ADR-0024.
- Orchestrator (in the gateway): boss agent answers, asks a clarifying question or delegates via structured output; worker runs sub-agents strictly from their manifests and reports Done/Failed to the thread; quiet retries. Seed agents `boss` and `web-dev`, seeded idempotently into `$ACHORDS_HOME/agents`. ADR-0025.
- Gateway HTTP API on 127.0.0.1:7420 (threads, messages, tasks, agents, write-only vault, devices) with pairing-code login, session cookies, CSRF and Host checks (ADR-0026). CLI: `achords pair web`, `achords secret set|list|rm` (value read from stdin, never argv).
- Telegram channel: long-poll, owner pairing (`achords pair telegram` + `/pair <code>`, bound to the user id, private chats only, unknown users silently ignored), `/stop` emergency stop, `/new` thread, agent replies delivered back (ADR-0027). Linux: systemd user service.
- Web UI (`apps/web`, Vite + Preact + TS): pairing screen, threads/chat, kanban, agents, write-only vault, devices with revoke. Served by the gateway at http://127.0.0.1:7420 under a strict CSP; `pnpm build` builds it (ADR-0028).
- `achords init` (re-runnable setup: prerequisite checks, data folder, Telegram token into the vault, service start, pairing codes) and `achords doctor` (Node, claude CLI, git, data folder permissions, web UI build, macOS folder access, service, gateway, vault, Telegram).
- `achords export|import`: passphrase-encrypted archive (scrypt + AES-256-GCM) of the whole data folder incl. vault secrets; import into an empty folder, re-keyed to the target machine, paths rewritten, sessions cleared, starts paused (ADR-0021 accepted).
- Minimal gateway daemon: pidfile, heartbeat, graceful SIGTERM, honours the STOP marker.
- Architecture: emergency stop (`achords kill`) and machine migration (export/import) design notes; ADR-0021 (Proposed).
