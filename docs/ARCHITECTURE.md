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
- Listens on: web UI/API (bound to localhost; remote access via Tailscale), Telegram long-poll, scheduler ticks.
- Owns no model. Spawns agent runs, collects results, routes them back to the right thread/channel.

### 4.2 Threads and channels

- A **thread** is the unit of conversation; channels (web, Telegram) are views onto it. Start on Telegram, continue on the web.
- Default output policy: agent asks clarifying questions if needed, then reports "done" with a result summary. Traces are stored but hidden; viewable on demand in the web UI.
- Each agent may have its own Telegram bot; the boss bot can route to sub-agents.

### 4.3 Orchestrator (boss agent)

- User picks provider + exact model for the boss.
- Decomposes tasks, assigns to sub-agents, tracks them on the kanban, asks the user only when blocked or when approval is required.
- Sub-agents get a default model per role; orchestrator may choose within an allowed set (autonomy setting).

### 4.4 Agent runner

- Each run is a short-lived process: frontier CLI subprocess (`claude -p`, `codex exec`), API call loop, or local model loop.
- Runs inside a per-agent working directory (git worktree for dev agents) and per-agent OS user where configured.
- Exits after the task. No idle tmux sessions.

### 4.5 Provider layer

Single interface `ModelProvider { run(task, tools, limits) }` with adapters:

- `cli-claude`, `cli-codex`: invoke the official binaries only. Never read, extract or proxy OAuth tokens.
- `api-anthropic`, `api-openai`, `api-google`, `api-openrouter`.
- `local-openai-compatible`: Ollama (default, MLX engine on Apple Silicon), `mlx-lm` server optional.
  Usage meters per provider:
- CLI mode: rolling window usage (5h / weekly) as reported by the CLI.
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
- `sensitivity`: data tagged `local-only` is always routed to local models; if none is available the task waits (fail-closed).

### 4.7 Workspaces (business branches)

Default layout, configurable:

- `studio` (game dev, Unity), `web-clients` (client web work), `shared/marketing`.
  Each workspace has its own memory namespace, MD vault folder, MCP set and secrets scope. Marketing gets read-only access to the others' public material.

### 4.8 Memory

- **Fast memory**: SQLite with FTS5 + `sqlite-vec`. Hybrid retrieval fused with Reciprocal Rank Fusion.
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

### 4.15 Secrets vault

- Master key in macOS Keychain (Linux: Secret Service, fallback 0600 file). Secrets encrypted with AES-256-GCM (envelope encryption) in a separate SQLite file.
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
- `achords doctor`, `achords update`, `achords start|stop`. Everything set at install is editable later in the engine room.

## 5. Repo layout (monorepo)

```
apps/gateway        daemon: channels, scheduler, API
apps/web            dashboard (localhost)
apps/cli            achords init / doctor / update
packages/core       orchestrator, task queue, threads
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

1. **MVP**: gateway, boss + 1 sub-agent, CLI-claude adapter, Telegram, web threads + kanban, SQLite memory, vault, `achords init`.
2. Local models (Ollama), sensitivity routing, voice, usage meters, scheduler UI.
3. Marketing stack MCPs, publish review/auto, heartbeat.
4. API mode adapters and billing meters, signed updates, fleet MCP.
5. Plugin API hardening, premium packs, skill shop (later).
