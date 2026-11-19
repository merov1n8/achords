# Architecture: achords

Status: Draft v0.1 (2026-11-19)
License: Apache-2.0 (core). Premium packs are separate, closed repos.

## 1. Goals

- Self-hosted, single-tenant multi-agent hub. One company = one fully isolated install. No SaaS.
- One orchestrator ("boss") agent plus role-scoped sub-agents (e.g. Unity dev, web dev, marketing).
- Per-agent model choice: frontier via subscription CLI (default) or API key (install-time option, switchable later), or local models.
- Sensitive data never leaves the machine (policy-enforced local routing, fail-closed).
- Interfaces: localhost web UI (English) and Telegram. Voice input on both. User may talk to agents in Hungarian.
- Quiet by default: user sees questions and results, not tool traces.
- Near-zero idle cost: agents and local models run only when there is work.
- Runs on Apple Silicon (Mac Mini, 32 GB target) with a swappable platform layer; Linux supported.
- Install and configure via CLI (`achords init`), reconfigure later in the web UI ("engine room").

## 2. Non-goals (v1)

- Multi-tenant hosting, cross-install communication between customers.
- Skill shop UI (planned for a later phase).
- Native mobile apps (web + Telegram cover remote use).

## 3. High-level view

```
 Telegram ─┐                         ┌─ Frontier adapters (CLI: claude, codex | API: Anthropic, OpenAI, Google, OpenRouter)
 Web UI ───┼─> Gateway (always on) ──┤
 Cron ─────┤    │                    └─ Local adapter (OpenAI-compatible: Ollama default, mlx-lm optional)
 Heartbeat ┘    v
           Orchestrator ──> Task queue (SQLite) ──> Agent runner (spawn on demand, exit when done)
                │                                        │
                v                                        v
           Policy engine (scopes, tools, budgets, sensitivity routing, approvals)
                │
     ┌──────────┼───────────────┬──────────────┬─────────────┐
     v          v               v              v             v
  Memory     MD vault        Secrets vault   MCP layer     Platform layer
 (SQLite     (Obsidian-      (encrypted,     (client +     (apple-silicon |
  FTS5+vec)   compatible)     broker)         own server)   generic)
```

## 4. Components

### 4.1 Gateway (always-on daemon)

- Small Node process supervised by launchd (macOS) / systemd (Linux).
- Listens on: web UI/API (bound to 127.0.0.1:7420; remote access via Tailscale), Telegram long-poll, scheduler ticks.
- Web/API access: one-time pairing code (`achords pair web`) exchanged for an HttpOnly/Secure/SameSite=Strict session cookie; CSRF header + Origin check on writes; exact Host allow-list; per-device revoke (ADR-0026).
- Owns no model. Spawns agent runs, collects results, routes them back to the right thread/channel.

### 4.2 Threads and channels

- A **thread** is the unit of conversation; channels (web, Telegram) are views onto it. Start on Telegram, continue on the web.
- Default output policy: agent asks clarifying questions if needed, then reports "done" with a result summary. Traces are stored but hidden; viewable on demand in the web UI.
- Each agent may have its own Telegram bot; the boss bot can route to sub-agents.
- Telegram is bound to one owner user id via a pairing code; private chats only; unknown users are ignored silently; `/stop` = emergency stop, `/new` = new thread (ADR-0027).
- Messages can carry actions (`{label, data}`, data `<kind>:<verb>:<id>`); Telegram renders them as inline buttons, accepts presses only from the paired owner in a private chat and removes the buttons once decided. This is the shared approval mechanism (agent proposals now; publishing in review mode and non-allow-listed shell commands later).
- Everything goes to the thread; web and Telegram are only views onto it. This includes local-only threads: local-only governs which models may process the data, not which of the owner's channels show it (maintainer decision, 2026-11-19).

### 4.3 Orchestrator (boss agent)

- User picks provider + exact model for the boss.
- Decomposes tasks, assigns to sub-agents, tracks them on the kanban, asks the user only when blocked or when approval is required.
- Sub-agents get a default model per role; orchestrator may choose within an allowed set (autonomy setting).

### 4.3.1 Inter-agent delegation (ADR-0029)

- Any agent can delegate, not only the boss: a `delegate` tool on the hub's own MCP server creates a linked child task (parent/child on the kanban). The boss→sub-agent flow is the same mechanism.
- The target runs with its own manifest, never the caller's; callers cannot pass tools, paths, models or secrets. Sensitivity only tightens (`local-only` propagates to every descendant), budget only shrinks.
- Policy: `delegation.can_delegate_to` (caller) and `delegation.accepts_from` (target), both deny by default; the boss may delegate to all.
- Guards: max depth 3, no cycles (A→B→A), fan-out limit, one budget per root task shared across the chain.
- Async: the parent waits; when children finish it is re-queued with their results. The owner sees only the final result or a question; `ask_owner` from any depth goes to the original thread and the reply is routed back to the asking task.
- Ephemeral workers: `spawn_worker` with a subset of the caller's permissions (max 3 per task, depth 1, shared budget); a new persistent agent needs owner approval (`propose_agent`).
- Status: the delegation core and the hub MCP server with the `delegate` tool are implemented: agents whose manifest allows delegation get the tool through a per-run, 0600 MCP config file (deleted after the run) carrying a run token that is revoked when the run ends; `/api/agent/*` accepts only that token (no cookie/CSRF, Host check still applies). The MCP server is a minimal hand-written stdio JSON-RPC implementation (no SDK). Every CLI run gets the hub with `ask_owner`; `delegate` only where the manifest allows it; the run token lists the granted tools and both the MCP server and the gateway enforce it. `ask_owner` posts the question into the original thread (attributed to the asking agent); the task waits, and the owner's next message in that thread is routed to the oldest open question instead of the boss. Workers: `spawn_worker` runs the caller's agent cut down to the requested tools/paths (rejected, never trimmed, if beyond the caller's own), max 3 per task, no hub tools (cannot delegate, spawn, propose or ask). Proposals: `propose_agent` validates the manifest strictly and posts every permission it would get into the thread; nothing is written until the owner approves (Telegram `/approve <id>` / `/reject <id>`, or the web API with a session). The hub MCP server will move to the official SDK together with the MCP client layer, and the hand-written implementation will then be removed (maintainer decision). The chain budget is the root agent's `budget.per_run_usd`.

### 4.4 Agent runner

- Each run is a short-lived process: frontier CLI subprocess (`claude -p`, `codex exec`), API call loop, or local model loop.
- Runs inside a per-agent working directory (git worktree for dev agents) and per-agent OS user where configured.
- Exits after the task. No idle tmux sessions.

### 4.5 Provider layer

Single interface `ModelProvider { run(task, tools, limits) }` with adapters:

- `cli-claude`, `cli-codex`: invoke the official binaries only. Never read, extract or proxy OAuth tokens.
- CLI runs are isolated from the user's own CLI config: no MCP servers or connectors, no user/project settings or hooks, only the manifest's tools; prompt on stdin; own process group (ADR-0024).
- `api-anthropic`, `api-openai`, `api-google`, `api-openrouter`.
- `local-openai-compatible`: Ollama (default, MLX engine on Apple Silicon), `mlx-lm` server optional. Manifest models `local/<name>`; `keep_alive` frees RAM when idle; structured output via `response_format`. Text only for now: a run that needs tools is refused, never run without them. `packages/platform` recommends a model by RAM (24 GB → `qwen3:8b`, embeddings `bge-m3`, multilingual).
  Usage meters per provider:
- CLI mode: rolling window usage (5h / weekly) as reported by the CLI (`rate_limit_event` in stream-json, recorded after each run).
- API mode: spend and remaining balance/credits from the provider's billing/usage endpoints where available; otherwise locally computed cost from token counts.

### 4.6 Policy engine

Per agent (declared in `agents/<id>/agent.yaml`):

- `workspace`: which business branch it belongs to.
- `models`: allowed providers/models.
- `tools` / `mcp`: allow-list; everything else denied.
- `fs`: readable / writable paths.
- `shell`: allow-list commands run directly; others require approval.
- `network`: allowed domains (enforced for containerized agents).
- `publish_mode`: `review | auto`, per channel (marketing).
- `budget`: token / cost caps per run and per day.
- `delegation`: `can_delegate_to` / `accepts_from` agent ids, deny by default (ADR-0029).
- `sensitivity`: data tagged `local-only` is always routed to local models; if none is available the task waits (fail-closed). Implemented for threads and tasks: a local-only thread runs the boss on a local model allowed by its manifest (or refuses), delegated tasks inherit local-only, a task whose local server is down is deferred (not counted as an attempt), memories from local-only work are tagged and never put into a frontier prompt. Threads become local-only one way only (Telegram `/local`, web API on creation).

Manifests are validated strictly (`yaml` + `zod`, ADR-0023): unknown keys are errors and every omitted section means "nothing allowed". Filesystem checks resolve symlinks so a link inside an allowed root cannot escape it; shell commands with metacharacters (chaining, substitution, redirects) always need approval.

### 4.7 Workspaces (business branches)

Default layout, configurable:

- `studio` (game dev, Unity), `web-clients` (client web work), `shared/marketing`.
  Each workspace has its own memory namespace, MD vault folder, MCP set and secrets scope. Marketing gets read-only access to the others' public material.

### 4.8 Memory

- **Fast memory**: SQLite (`node:sqlite`, ADR-0022) with FTS5 + `sqlite-vec`. Hybrid retrieval fused with weighted Reciprocal Rank Fusion (semantic ×2; vector hits only within 0.1 cosine of the best, so mere presence earns nothing); trigram keyword index for Hungarian word forms. Separate `memory.db`; without the local embedding model memory falls back to keyword search and vectors are backfilled later. The boss recalls across all workspaces, sub-agents only their own plus `shared`; finished tasks are stored as redacted summaries. (Implemented: Phase 2 step 2; tiers, salience decay and the MD vault come later.)
- Tiers: hot / warm / cold / shared. Salience decay (never auto-delete).
- Embeddings computed locally (Ollama embedding model), never sent to frontier providers.
- **MD vault**: per workspace, Obsidian-compatible (frontmatter, `[[links]]`). Holds decisions, daily journals, project notes, skills.
- Daily journal job each evening; pre-compaction save of key decisions.
- Memory graph view in the web UI.

### 4.9 Skills

- Markdown skills with progressive disclosure (index, summary, full body) to save tokens.
- Self-learning: after complex tasks or error recovery, agents propose new skills or targeted patches; the user can require review before a skill is activated.
- Seed skills and scheduled tasks ship from `seed/`; seeding is idempotent and never overwrites local edits.

### 4.10 Scheduler and heartbeat

- Cron-style schedules stored in SQLite, editable in the UI (list, daily timeline, weekly view). Every run reports a result.
- Heartbeat monitors: cheap periodic checks (calendar, mail, kanban, ads metrics) that notify only when something matters. Prefer local models for heartbeat triage.

### 4.11 Kanban

- Workflow per workspace (ADR-0030, planned): `workflow.yaml` with columns, transitions (`by: assignee | role:<x> | owner`, `not: assignee` for four-eyes) and `on_enter` automation (`assign: role:qa`, `approve: owner`). Agents move cards via the `move_task` hub tool only; the owner may drag & drop anything (Pointer Events, touch-friendly), logged. A permission matrix view shows who may do what.

- Cards created by the user or the orchestrator; AI breakdown into subtasks, swimlanes by owner/priority, per-column WIP limits, card aging.

### 4.12 Dashboard

- Views: team/agents, threads, kanban, schedules, memory graph, usage meters, vault (masked), engine room (settings).
- Usage meters per provider: subscription window utilization or API spend/balance.

### 4.13 Voice

- Telegram voice notes and web mic recordings are transcribed by a local Whisper (`whisper.cpp` / `mlx-whisper`). Browser Web Speech API is not used (it may send audio to third parties).

### 4.14 MCP layer

- MCP client for all integrations, configured from a catalog; credentials resolved from the vault.
- Default catalog: Google Ads, Analytics, Search Console, AdMob, Google Cloud / Firebase, Meta (Facebook, Instagram), TikTok, Reddit, App Store Connect, Google Play Console, WordPress, ElevenLabs, fal.ai, Meshy, Gmail/Calendar/Drive, Unity MCP.
- The hub also exposes its own MCP server (tasks, threads, memory search) so external clients can drive it, subject to the policy engine.
- Agent runs get the hub's MCP server (and only that, plus catalog servers their manifest allows) with a per-run capability token: `delegate`, `ask_owner`, `spawn_worker`, `propose_agent`, later `report_progress` (ADR-0029). The caller's identity comes from the token, never from tool arguments.

### 4.15 Secrets vault

- Master key in macOS Keychain (Linux: Secret Service, fallback 0600 file). Secrets encrypted with AES-256-GCM (envelope encryption) in a separate SQLite file (`vault.db`).
- Each secret has its own data key; ciphertexts are bound to their secret id (GCM AAD), so rows cannot be swapped. The master key is passed to `security` on stdin, never argv (visible in `ps`). `last4` is only kept for values of 12+ characters.
- Write-only in UI and API: the server never returns a secret value, only `set/unset`, last 4 chars, updated date. Nothing secret is ever rendered into HTML.
- Config files reference `vault:<id>` only.
- Injection: preferably a broker adds credentials to outbound requests so agents never see values; otherwise injected into the single process env at spawn time.
- Redaction filter on logs, channel messages, memory writes and frontier prompts (known secrets + common key patterns).
- Audit log of secret use per agent.

### 4.16 Execution safety

- Default: allow-list + approval (approvals arrive on Telegram/web).
- Dev agents: git worktrees, optional dedicated macOS user.
- Untrusted-input agents (marketing, scraping): container with domain allow-list.

### 4.17 Platform layer

- Interface for hardware-specific concerns: local model runtime selection, model size recommendations by RAM, power/idle tuning (model `keep_alive`, unload TTL), Metal/MLX availability checks.
- Implementations: `platform-apple-silicon`, `platform-generic`. Detected at install, overridable.

### 4.18 Remote access and maintenance

- Remote access via Tailscale; ACL limits devices to the dashboard port.
- Updates are **pull-based**: signed releases, verified locally, applied after user approval.
- Optional opt-in maintenance heartbeat sends only version, health and error codes to the vendor's fleet MCP. No inbound access, no agent control, no customer data. There is no endpoint that allows it.

### 4.19 Install

- `achords init`: dependency check, platform detection, provider mode (CLI or API), CLI login handoff, Telegram bot setup, workspace and agent templates, local model pull, service install.
- `achords doctor`, `achords update`, `achords start|stop|status|kill|resume`. Everything set at install is editable later in the engine room.
- Emergency stop (`achords kill`) must work even if the gateway is hung: it unloads the launchd/systemd service (so `KeepAlive` cannot restart it), kills every agent run's process group (PIDs recorded in `runs`), pauses the task queue and writes a STOP marker the gateway refuses to start past. `achords resume` clears it (details and manual fallback: `docs/OPERATIONS.md`). Telegram `/stop` from the paired owner chat triggers the same path.

### 4.20 Machine migration (export / import)

Status: implemented (`achords export|import`, ADR-0021).

- All state lives under one root (`ACHORDS_HOME`, default `~/.achords`): config, agent manifests, skills, schedules, SQLite databases, MD vaults, logs. Only the vault master key lives outside (Keychain).
- `achords export <file>` writes one archive, fully encrypted with a user passphrase (memory and threads may hold `local-only` data). Includes: config, agents, skills, schedules, workspaces, MD vaults, databases (threads, kanban, memory), schema version.
- Vault secrets (API keys, Telegram tokens, MCP credentials) are re-wrapped with the export passphrase; on import they are re-wrapped with the target machine's Keychain key. Values are never decrypted to disk or shown.
- Not exportable, must be redone on the target: subscription CLI logins (`claude`, `codex`; OAuth tokens are never touched, ADR-0004), Tailscale node identity, local model weights (the model list is exported, `achords doctor` re-pulls).
- `achords import <file>` refuses newer schema versions, runs migrations for older ones, rewrites machine-specific paths, and starts paused. Export leaves the source paused, because a Telegram bot can only be long-polled by one install at a time.

## 5. Repo layout (monorepo)

```
apps/gateway        daemon: channels, scheduler, API, orchestrator (ADR-0025)
apps/web            dashboard (Vite + Preact + TS, served by the gateway; ADR-0028)
apps/cli            achords init / doctor / update
packages/core       data layer: threads, task queue, runs, agents
packages/policy     policy engine
packages/providers  model adapters + usage meters
packages/memory     SQLite fast memory + MD vault sync
packages/secrets    vault + broker + redaction
packages/mcp        MCP client, catalog, own MCP server
packages/platform   apple-silicon / generic
packages/plugin-api premium/extension interface
seed/               skills, schedules, agent templates
docs/adr/           decision records
```

## 6. Delivery phases

1. **MVP**: gateway, boss + 1 sub-agent, CLI-claude adapter, Telegram, web threads + kanban, SQLite memory, vault, `achords init`, start/stop/kill control, export/import.
2. Local models (Ollama), sensitivity routing, voice, usage meters, scheduler UI.
3. Marketing stack MCPs, publish review/auto, heartbeat.
4. API mode adapters and billing meters, signed updates, fleet MCP.
5. Plugin API hardening, premium packs, skill shop (later).

### To reconsider (after the last phase)

- Colibri (pure-C, SSD-streamed MoE engine, Apache-2.0) as an optional `local-batch` profile for slow, scheduled, `local-only` jobs. Benchmark on the Mac Mini SSD first.
