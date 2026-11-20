# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- **Security:** agent file and fetch permissions are now enforced by the CLI. A manifest granting `Read`/`Edit`/`Write`/`WebFetch` used to allow them everywhere (any file of the user, any web host), because a bare tool name in `--allowedTools` is unscoped. Rules are now scoped to the agent's `fs.read`/`fs.write` folders (its working folder when none) and its `network.allow` hosts; the rest is refused. Verified against the real CLI.

- The web session cookie is named per gateway port (`achords_session_<port>`). Browsers share cookies across ports of one host, so pairing a second gateway on 127.0.0.1 (a test instance) silently replaced the owner's session and brought back the pairing screen. Existing browsers need to pair once more after this update.

- Saving model settings keeps the `allowed` list in the style written in `agent.yaml` (one `- model` per line stays that way) instead of turning it into `[a, b]`.

- The gateway log now says why a web request was not authenticated (no session cookie vs. unknown/revoked/expired session), never the token itself, to diagnose unexpected pairing screens.

- Manifests reject claude CLI model names that are neither an alias (opus, sonnet, haiku, fable) nor a full name (`cli-claude/claude-opus` used to pass and would only fail at the first model call).
- Seeded boss manifest comment no longer shows the substituted data path.

- Memory ranking for Hungarian: multilingual `bge-m3` is the default embedding model (`nomic-embed-text` scored like no embeddings at all), weighted fusion, and dissimilar vector hits no longer earn rank points.

- Memory keyword search matches Hungarian suffixed word forms (trigram index): "WordPresst" finds "WordPress", "Kovácséknak" finds "Kovács".

- Gateway service could not find the `claude` CLI (`spawn claude ENOENT`): launchd/systemd jobs now get the PATH of the shell that ran `achords start`; `achords doctor` checks the installed service's PATH.

### Changed

- The hub's own MCP server (delegate, ask_owner, …) runs on the official MCP TypeScript SDK (`@modelcontextprotocol/server`) instead of a hand-written JSON-RPC loop; same tools, same run tokens.

- Sub-agents write their final report in the language the owner uses with the boss.

### Added

- Full access on request: an agent can ask for it in the conversation (Approve / Reject). For 4 hours that task can read any website, search the web and use the write tools of Blender and Unity. Client integrations with credentials (Google, Meta, WordPress) are left out while it is on.
- `achords connect google <client.json>`: one Google sign-in in the browser (Desktop-app OAuth client, loopback redirect, PKCE) for Analytics and Search Console. The client credentials and the refresh token go straight into the vault; achords never sees the password. Clients grant your Google account access to their properties, so one sign-in covers all of them.
- First integrations in the catalog: WordPress (no plugin needed: reads posts and pages, creates drafts, never publishes; per client project credentials), Google Analytics 4, Google Search Console, Meta (Facebook Pages and Instagram), Blender and Unity. Ecosystem servers are pinned to exact versions, telemetry is switched off, and agents get only reading tools for now.
- Integration catalog (ADR-0034): an agent whose manifest lists `mcp: [id]` gets that MCP server from `seed/catalog/` or `~/.achords/catalog/`, with read tools only for now. Credentials come from the vault through a one-time ticket, so they never appear in the agent's config, prompt or environment; per-client credentials with `vault:<name>-{project}`. Agents with a shell are refused integrations that need credentials.

- Planned stop: `achords stop` now waits for running agent work to finish (up to 10 minutes, `--wait 30m` to change, Ctrl+C cancels the stop) and starts nothing new meanwhile. Work still running at the limit, or with `--now`, is interrupted and continues after `achords start` from a note with the agent's checklist, without using up one of its attempts.

- CLI output (help, status, doctor, init, pair, secret, export/import, start/stop/kill/resume) now comes from the shared text catalog too, so one `locales/<lang>.json` translates the web UI, Telegram and the CLI. A test fails if the CLI or the gateway uses a key the catalog lacks.

- Edit projects (name, workspace, PROJECT.md text) and schedules (all fields) in the web UI. Project files stay Finder-only.

- Scheduler (ADR-0033): recurring tasks with cron rules (e.g. `0 9 * * 1-5` = weekdays at 9:00, local time). The gateway starts them on time through the normal agent flow; each schedule reports into its own chat thread. Missed runs are caught up once; a run still going skips the next occurrence. Schedules page: list with on/off and delete, today's runs and a week view.

- Usage meters: a Usage page shows the Claude subscription windows (5-hour, 7-day) as reported after every run, with reset times, plus the API-equivalent cost of today's runs. At 80% and 95% of a window you get one note in your thread (Telegram and web). Boss decisions are now recorded as runs too (cost, quota, `achords kill`, live bar).

- Live run progress: a bar at the bottom of every page shows each running agent's task, the step it is on, % done (from its own TodoWrite checklist), elapsed time and an estimate of the time left (only after the first step is done). Task runs get Claude Code's TodoWrite tool for this; it only keeps the run's own checklist.

- Agent rooms (ADR-0032): an agent can open a short discussion (`open_room`) with up to 3 agents it may delegate to, 1–3 rounds, read-only turns; it resumes with the transcript and writes the decision. Rooms never show up in chats or Telegram; the owner can read them under Settings › Agent rooms.

- Projects in the web UI: a Projects page (list with working folder paths, create form) and a project picker in the chat header.

- Projects (ADR-0031), backend: `projects/<slug>/` with `project.yaml`, `PROJECT.md`, `files/` and an optional own workflow. Pick a project for a Telegram thread with `/project <slug>` (`/project` lists, `/project none` clears); API for listing, creating and assigning. Project work gets `PROJECT.md` in every run, agents of the project's workspace work directly in `files/`, and project memory is kept apart from other clients'. Web screens follow.

- Agents view: rename an agent (id and role stay), and create a new agent from a form (id, name, job role, workspace, scope → `AGENT.md`, workflow roles, model). Every permission starts off: tools, write/read paths, shell commands, network hosts, delegation and budget are switched on one by one; the manifest is validated with the strict schema before anything is written.

- `AGENT.md` per agent (replaces `prompt.md`, which still works on older installs): scope, what the agent does not do, hand-offs and way of working. The boss and delegating agents see each agent's one-paragraph scope when choosing who gets the work. New seeds for boss and web-dev.

- Web kanban on the workflow (ADR-0030): workflow columns per workspace in one scrolling row, drag & drop with Pointer Events (mouse, pen; touch from the grip so the page still scrolls), keyboard moves (Space, ←/→, Enter, Esc), drop targets show whether a move follows the rules or is a logged override, subtask counts on cards, and a read-only rules table.

- Workflow in the gateway (ADR-0030): each workspace gets `workflows/<workspace>.yaml` (default seeded once); tasks given to agents appear as cards, finished work moves to review automatically; a QA agent (role `qa`) gets review work and can move it to done, the developer cannot; agents move cards with the new `move_task` hub tool; owner moves via `POST /api/tasks/:id/move` (overrides logged); `approve: owner` columns ask with Approve/Reject buttons on Telegram and web.

- Workflow rules (ADR-0030), groundwork: `workflow.yaml` schema with columns, transitions (`by: owner | assignee | role:<name>`, `not: assignee` four-eyes check) and `on_enter` automation; default workflow backlog → todo → in_progress → review → done → deployed; `roles` in agent.yaml; every card move is logged (owner overrides flagged). Not wired into the gateway and web yet.

- Voice notes in the web chat: the mic button records in the browser, the gateway transcribes on this machine with Whisper (audio never leaves the host, temp files removed), and the text lands in the message box to review before sending.

- Per-agent model settings in the web Agents view: tick allowed models (aliases, pulled local models or any `provider/model`) and pick the default. Saved to `agent.yaml` with comments and layout kept, validated before writing (an invalid change leaves the file untouched); applies to the next run without a restart.

- Approval buttons in the web chat (same actions as on Telegram); deciding in either place removes the buttons everywhere.
- Shared text catalog `packages/i18n` (`locales/en.json`): web UI, Telegram bot texts and buttons, and thread messages (Done/Failed, questions, proposals) all come from one file per language.

- New web design (approved samples): light pastel / dark anthracite themes following macOS day/night, violet or teal accent (Settings > Appearance), left sidebar tree with collapsible groups (drawer on phones), Inter + JetBrains Mono + Lucide icons bundled for offline use, all views restyled. All UI text comes from `locales/en.json` via `t()` (a test fails if a used key is missing).

- Voice notes (ADR-0014): the owner's Telegram voice notes are downloaded (owner only, max 10 min), transcribed on the host with whisper.cpp (large-v3-turbo, language auto-detect) and handled like typed text; audio files are deleted afterwards. `achords doctor` checks Whisper and the model. Real Hungarian test: near-perfect transcript in ~6 s.

- Approval buttons: messages can carry actions; Telegram shows them as inline buttons (✅ Approve / ❌ Reject for agent proposals), accepts presses only from the paired owner in a private chat, and removes the buttons after the decision. `/approve` / `/reject` remain as a fallback.

- Ephemeral workers (`spawn_worker`: subset of the caller's tools and write paths, rejected if beyond them, max 3 per task, no hub tools) and agent proposals (`propose_agent`: strict validation, full permission summary in the thread, created only after the owner's `/approve` or web approval). Verified with the real `claude` CLI.

- `ask_owner`: any agent, at any delegation depth, can ask the owner a question; it appears in the original thread, the task waits, and the owner's reply is routed back to that agent (not the boss). Run tokens are scoped to the granted hub tools. Verified with the real `claude` CLI.

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
