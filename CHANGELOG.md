# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added

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
- Minimal gateway daemon: pidfile, heartbeat, graceful SIGTERM, honours the STOP marker.
- Architecture: emergency stop (`achords kill`) and machine migration (export/import) design notes; ADR-0021 (Proposed).
