# Architecture: Achords

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

- A **thread** is the unit of conversation; channels (web, Telegram) are views onto it. Start on Telegram, continue on the web. With the bot's forum topic mode on, each thread has its own Telegram topic, a topic opened in Telegram starts a thread, and idle topics are removed after 7 days (ADR-0063); otherwise Telegram shows one thread at a time.
- Default output policy: agent asks clarifying questions if needed, then reports "done" with a result summary. Traces are stored but hidden; viewable on demand in the web UI.
- Each agent may have its own Telegram bot; the boss bot can route to sub-agents.
- Telegram is bound to one owner user id via a pairing code; private chats only; unknown users are ignored silently; `/stop` = emergency stop, `/new` = new thread (ADR-0027).
- Messages can carry actions (`{label, data}`, data `<kind>:<verb>:<id>`); Telegram renders them as inline buttons, accepts presses only from the paired owner in a private chat and removes the buttons once decided. This is the shared approval mechanism (agent proposals now; publishing in review mode and non-allow-listed shell commands later).
- Everything goes to the thread; web and Telegram are only views onto it. This includes local-only threads: local-only governs which models may process the data, not which of the owner's channels show it (maintainer decision, 2026-11-19).

### 4.3 Orchestrator (boss agent)

- User picks provider + exact model for the boss.
- Decomposes tasks, assigns to sub-agents, tracks them on the kanban, asks the user only when blocked or when approval is required.
- Sub-agents get a default model per role; orchestrator may choose within an allowed set (autonomy setting).
- Each agent has an `AGENT.md` next to its `agent.yaml`: its scope (what it does, what it does not, what it hands to whom) and way of working. Its own runs get it as system prompt; whoever routes work (the boss, delegating agents) sees the first paragraph after each agent's name. Hard limits stay in `agent.yaml`: the boss has no tools, so it cannot do the work itself whatever model it runs on. Older installs' `prompt.md` is still read when there is no `AGENT.md`.
- The boss runs only for the owner's message or for a stall notice (ADR-0066): both are one structured decision in the chat's thread (history, team, memories), not a task. A notice gets the chain's facts and answers with `ask_owner` (posts the question), `stop_chain` (the ADR-0052 Stop for that root's chain only, `stopChain` in core) or `let_run` (nothing posted); for an owner's message these three are only a reply.

### 4.3.1 Inter-agent delegation (ADR-0029)

- Any agent can delegate, not only the boss: a `delegate` tool on the hub's own MCP server creates a linked child task (parent/child on the kanban). The boss→sub-agent flow is the same mechanism.
- The target runs with its own manifest, never the caller's; callers cannot pass tools, paths, models or secrets. Sensitivity only tightens (`local-only` propagates to every descendant), budget only shrinks.
- Policy: `delegation.can_delegate_to` (caller) and `delegation.accepts_from` (target), both deny by default; the boss may delegate to all.
- Guards: max depth 3, no cycles (A→B→A), fan-out limit, one budget per root task shared across the chain.
- Handoff (ADR-0055): `handoff` passes the work on as a tail call. The caller's run ends; the successor is its sibling (same parent and depth) and gets the caller's report, and its result goes where the caller's would have gone. Pipelines (script → voice → edit → post) so do not use up depth. Guards: same delegation switches, one per run and none with open children, no earlier step of the line as target, at most 6 handoffs in a row, at most 20 delegated and handed-off tasks per root.
- Async: the parent waits; when children finish it is re-queued with their results. The owner sees only the final result or a question; `ask_owner` from any depth goes to the original thread and the reply is routed back to the asking task. A delegated task (or a handoff successor under a parent) may instead `ask_parent` (ADR-0066, at most 3 per task): it waits with `waiting_parent`, its question wakes the parent despite open children, the parent answers with `answer_child` (or asks the owner first), and the child is re-queued with the answer; a wake left unanswered keeps the question open without waking the parent again. The chat's run details list each task's latest question and answer (`parentQuestions` of the thread summary). Roots, workflow reviews, workers and room turns do not get the tool, and the owner's chat replies only answer `ask_owner`.
- Agent rooms (ADR-0032): `open_room` starts a bounded discussion (≤ 3 participants the opener may delegate to, ≤ 3 rounds) run as sequential read-only child turns; the opener resumes with the transcript and closes the room with an outcome (ADR-0066): `record_room_outcome(room, decision, decided_by, open_points)`, given only to the opener's run once a room's turns are over; without the call its result is the decision (decided by the opener, open point "not stated"), and a finally failed turn records "no decision: room failed". The outcome is stored as `rooms.outcome` (JSON) and posted as a comment (author: the opener agent) on the card of the opener's root, so it moves with the card (ADR-0059); card runs get the card's room outcomes, newest first, at most 5 (a resumed session only the new ones). Rooms are hidden threads (kind `room`): not in chats, not on Telegram; readable in the web audit view. Outcomes appear only on the card.
- Ephemeral workers: `spawn_worker` with a subset of the caller's permissions (max 3 per task, depth 1, shared budget); a new persistent agent needs owner approval (`propose_agent`).
- Status: the delegation core and the hub MCP server with the `delegate` tool are implemented: agents whose manifest allows delegation get the tool through a per-run, 0600 MCP config file (deleted after the run) carrying a run token that is revoked when the run ends; `/api/agent/*` accepts only that token (no cookie/CSRF, Host check still applies). The MCP server is built on the official MCP TypeScript SDK (`@modelcontextprotocol/server`). Every CLI run gets the hub with `ask_owner`; `delegate` only where the manifest allows it; the run token lists the granted tools and both the MCP server and the gateway enforce it. `ask_owner` posts the question into the original thread (attributed to the asking agent); the task waits, and the owner's next message in that thread is routed to the oldest open question instead of the boss. Workers: `spawn_worker` runs the caller's agent cut down to the requested tools/paths (rejected, never trimmed, if beyond the caller's own), max 3 per task, no hub tools (cannot delegate, spawn, propose or ask). Proposals: `propose_agent` validates the manifest strictly and posts every permission it would get into the thread; nothing is written until the owner approves (Telegram `/approve <id>` / `/reject <id>`, or the web API with a session). The chain budget is the root agent's `budget.per_run_usd`.

### 4.4 Agent runner

- Each run is a short-lived process: frontier CLI subprocess (`claude -p`, `codex exec`), API call loop, or local model loop.
- Runs inside a per-agent working directory (git worktree for dev agents) and per-agent OS user where configured.
- Exits after the task. No idle tmux sessions.

- Live progress (Phase 2 step 5b): task runs get Claude Code's `TodoWrite` tool (it only keeps the run's own checklist: no file, shell or network access) and a hint to use it; the adapter turns its stream-json calls into done/total/current, stored on the run (`runs.progress_*`) and polled by the web's bottom bar. The time left is extrapolated from elapsed time and is shown only after the first step is done. Discussion turns and the boss decision run without it.

- Usage meters (Phase 2 step 6): every run (boss decisions included) stores its cost and the subscription windows the CLI reports (`usage_windows`, latest per provider and kind). The web Usage page shows them; the owner gets one note per window and level (80%, 95%) through `notify` (Telegram thread, visible on the web too).

### 4.5 Provider layer

Single interface `ModelProvider { run(task, tools, limits) }` with adapters:

- `cli-claude`, `cli-codex`: invoke the official binaries only. Never read, extract or proxy OAuth tokens. `cli-codex` (ADR-0040): a permissions profile (home denied except the run's folders), network only with owner-granted full access, Achords MCP tools and credential-free integrations with tokens kept off the command line.
- CLI runs are isolated from the user's own CLI config: no MCP servers or connectors, no user/project settings or hooks, only the manifest's tools; prompt on stdin; own process group (ADR-0024). Card runs of Claude keep one session per agent and card in their own config folder (`CLAUDE_CONFIG_DIR=$ACHORDS_HOME/sessions/<card>/<agent>/`, signed in with the container token) and resume it with a prompt of what is new; a different model or trust, a rejected resume, workers and discussion turns start afresh, and the folder goes when the card is done, archived or deleted (ADR-0066). Every Claude run sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (also passed into containers), so the CLI's Bash, hooks and MCP servers never inherit `CLAUDE_CODE_OAUTH_TOKEN` or an API key.
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
- `network`: allowed domains; `*` = any website. With `*` the run executes in an Apple container unless `container: false` (owner's own risk; ADR-0051).
- `publish_mode`: `review | auto`, per channel (marketing).
- `budget`: token / cost caps per run and per day.
- `delegation`: `can_delegate_to` / `accepts_from` agent ids, deny by default (ADR-0029).
- `sensitivity`: data tagged `local-only` is always routed to local models; if none is available the task waits (fail-closed). Implemented for threads and tasks: a local-only thread runs the boss on a local model allowed by its manifest (or refuses), delegated tasks inherit local-only, a task whose local server is down is deferred (not counted as an attempt), memories from local-only work are tagged and never put into a frontier prompt. Threads become local-only one way only (Telegram `/local`, web API on creation).
- `level` (ADR-0067): 0 off to 5 full; effective per project as `min(override ?? level, ceiling)` (secured 4, experimental 5; overrides in `overrides.yaml` raise only on experimental projects; no project = `own`, experimental). Projects carry `class` and `env: live | staging` per account and site; catalog tools carry a class (`read`, `draft`, `reversible`, `live`, `spend`). Agents without `level` keep their lists exactly; for agents with one, `compileLevel` (`packages/policy/src/compile.ts`) replaces `tools`, `shell`, `network`, `container` and the integration tool lists once per run, right after the project folders are added; project sites, elevation and worker/discussion/codex/gemini trimming apply on top. The shell request check, delegation refusal, the boss's change_agent listing and `GET /api/agents/:id` (effective level per project, reason, remit conflicts) read the compiled result.
  - L0: no work (delegation, card start, dispatch, workflow review refused). L1: `Read, Glob, Grep` on `fs.read` + `fs.write`. L2: `Edit, Write` on `fs.write`, `WebFetch`, `WebSearch`, network `*`. L3: remit integrations, tools of class read/draft/reversible directly; live and spend always through publishing review. L4: `Bash` without a command list, only in a sandbox. L5: live follows `publish_mode`; spend asks on secured projects and on experimental ones unless `spend_without_asking`.
  - Open web never shares a run with draft+ account tools, nor a host run with a shell: a leveled agent at L3+ with a shell (L4+) or draft+ account tools is split and runs each task in work mode (`tasks.run_mode` null or `accounts`: shell and account tools; no open web, only project sites, the package registries and the remit's named `network.allow` hosts, never `*`) or `web` mode (`WebFetch` any, `WebSearch`; no shell, keyed integrations out, keyless ones keep read tools; like every Claude run with the open web it runs in the Apple container (ADR-0051), so local-app integrations leave). A `handoff` to itself switches modes; it counts toward the hop and task limits. Full access (ADR-0035) does not apply to leveled agents (the approval scopes below replace it). Codex gets network only in web mode. L2 and unsplit L3 agents keep the web in every run (in a container, ADR-0051).
  - L4 sandbox (work mode only): Claude runs use an Apple container when the run has keyed integrations (ADR-0055; network still the work mode's hosts for its tools), otherwise the CLI's own sandbox via `--settings` (`sandbox.enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed`, no unsandboxed escape, network = package registries + the run's hosts, writes = the run's folders, reads of the whole user home and `$ACHORDS_HOME` denied, re-allowed only for the run's folders, a per-run cache folder (`$ACHORDS_HOME/run/cache-<uuid>`, writable, removed after the run) and toolchain folders present under the home (`HOME_TOOLCHAINS`, plus the gateway's PATH folders there and their install folder, plus the install folder of every symlinked program in them, e.g. `~/.local/bin/node` → `~/.local/opt/node-v24/`), never a folder that is or holds a credential file (`HOME_KEYS`: `~/.ssh`, `~/.aws`, `~/.config`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.docker`, `~/.kube`, `~/.claude`…, also denied by name) and nothing in `$ACHORDS_HOME` but the run's folders; the global git config (`~/.gitconfig`, `~/.config/git/config`, their includes and the files they name such as `core.excludesfile` and `commit.template`) is readable by file when it has no secret-looking content (`GIT_SECRET`: token, password, secret, bearer, `_auth`, a URL with a user) and the file is no credential path: git stops on an unreadable global config, and the CLI's scrub drops `GIT_CONFIG_GLOBAL` (a secret-looking config stays denied and git in the shell stops); the run's environment points package caches (`npm_config_cache`, pnpm store, `YARN_CACHE_FOLDER`, `PIP_CACHE_DIR`, `NUGET_PACKAGES`, bun) into the cache folder (user config files are not redirected: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` also drops `GIT_CONFIG_GLOBAL`, `XDG_CONFIG_HOME`, `npm_config_userconfig`, `PIP_CONFIG_FILE`, `GIT_ASKPASS`, `SSH_ASKPASS` and `SSH_AUTH_SOCK` before Bash, checked with claude 2.1.331, so `~/.npmrc` and the like stay out by the read denies) and carries the owner's git `user.name`/`user.email` as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`; `CARGO_HOME` is left alone, `git push` and history rewrite denied as best-effort prefix rules). Only the remit's `unsandboxed` executables are `excludedCommands`. Owner-approved exception `keys_beside_host_shell`: an L4+ shell stays in the host sandbox beside keyed integrations (served by the gateway, refused otherwise), so local apps stay reachable; never beside the open web; ends with ADR-0055 stage 2. Codex and Gemini use their own sandboxes. Without any sandbox L4 compiles to L3 and the chat says why; container runs leave local apps out and say so.
  - Secured-live rule (every agent, leveled or not; `packages/policy/src/live.ts`): on a project whose class is `secured` or unset, write tools (every class but `read`) to an account or site entry tagged `live` or untagged are refused; writes go to `staging` entries only. `buildLaunch` puts a `live` guard into every launch, so the launcher refuses such calls before publishing review, for agent runs and owner-approved publishes alike; `requestPublish` and the Approve button check it again with a message to switch the target to staging or deliver a package. The target comes from the catalog `scope.args` (and the only target when `scope.optional`), else from what the server is configured with (all `sites`, the first entry of each `{account:<channel>}`); a write whose target cannot be told (a `scope.free` write tool, a call without the argument, per-client `{project}` credentials without a named account) is refused. Entries that reach no project account or site (local apps, owner-wide services) are not covered. The run's prompt names the staging targets as writable, the live ones as read-only, and says work for live is delivered as a package for the owner. Experimental projects and `own`: writes follow the level. No level, override, elevation or approval lifts it.
  - Approvals (step 4): a leveled agent asks with the hub tool `request_permission {kind, target, reason}` (instead of `request_access`/`request_command`): `folder` (absolute path), `project` (another project's work and files folders), `integration` (catalog id; from level 3), `level` (1-5), `command` (no shell yet: a raise to 4; a level 4 shell runs commands directly, only a `rm`-like command naming paths outside its folders asks, as a folder) and `web` (a split agent switches by handoff, so it is refused; otherwise a raise to 2). Each request becomes one grant (folders, an integration or a level), stored as `pending_perm:<id>` and posted with buttons `perm:once|card|always|reject:<id>`; the task waits like for a question. Once: `approval_once:<task>`, used up by that task's next run. For this card: `approval:<cardKey>`, applied to every later task of the card (successors share the key; `carryCardSessions` moves it) until the card is done (`cardDone`), archived or deleted (`endCardSessions` clears it). Always: an ADR-0041 patch of `fs.write` or `mcp` (layout kept), or a level override in `overrides.yaml` (experimental projects and `own` only); asked again, the request is refused as already granted. Grants apply before compiling; a level grant never passes the ceiling, so no approval lifts the secured-live rule (a raise above a secured ceiling is refused with it). No "always" (button hidden, action refused) for always-ask items (deleting outside its folders, changing permissions with `chmod`/`chown`/`sudo`…, reading keys: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, Keychains, achords' home or `security`; an integration with a `spend` tool as a new paid service) and for level raises on secured projects. Force push, history rewrite and any `git push` command are refused outright (L5 pushes with `push_branch`, below). Spending keeps asking through publishing review (ADR-0037). Leveled agents ignore a chain's 4 h full access. Legacy agents keep `request_access`/`request_command` with the 4 h chain grant, now labelled "For this card", plus "Once" (`access:once`, `cmd:once`: that task's next run only).
  - Web UI (step 6): the agent form edits `level` and the remit folders of a leveled agent (create and update refuse `tools`, `shell`, `network`, `container` next to a level; a level-less agent gets its level only through `achords levels migrate`), shows its `mcp`, `unsandboxed` and `keys_beside_host_shell` read-only, and its overrides through `PUT /api/agents/:id/overrides` (this agent's entries of `overrides.yaml`, others kept; `saveOverrides` refusals as 400). `GET /api/agents/:id` gives per project the class, effective level and reason, plus `no-sandbox` or `local-model` when a run with the default model would compile lower. The project API reads and writes `class` and `spend_without_asking` and returns `ceiling` and `entries` (`{value, env}` per account); account lists take plain strings (env kept) or `{value, env}`; `GET/PUT /api/accounts` return `entries` too; `PUT /api/projects/:slug/sites/:id/:url {env}` tags a site.
  - Local models: level 3 at most, never the open web. Force push (`-f` also in a short-option cluster, `--force`, `--force-with-lease`, `--mirror`, a `+<ref>` refspec) and `git filter-branch` / `filter-repo` are refused for every agent.
  - Push (L5, work mode, any provider; `CompiledLevel.push`; not workers or discussion turns): the hub tool `push_branch {folder, branch, remote_url?}`, run by the gateway (`apps/gateway/src/git-push.ts`); the run's shell never holds a push credential. Checks (`pushTarget`, `packages/policy/src/git.ts`, re-read per call): the branch is a plain ref name (no `+`, `:`, leading `-`, `..`, spaces); the folder is inside one of the run's write folders and has a real `.git` directory without alternates; the target is the project's https `repository` entry (with several, `remote_url` must match one), not `live` on a secured project; `git-token-<project>` (`git-token-own` without a project) is set. The gateway then creates a 0700 bare repo under `$ACHORDS_HOME/run`, fetches `refs/heads/<branch>` from the agent's folder with no credential anywhere (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`, `HOME` = the temp dir, `core.hooksPath=/dev/null`, empty `credential.helper`), and pushes `refs/heads/<branch>:refs/heads/<branch>` without force (`--no-verify`, `http.followRedirects=false`), so the remote refuses a non-fast-forward and nothing can be deleted. The token is read from the vault (audited as `agent:<id>/git-push:<project>:<host>/<path>:<branch>`) and handed to git's askpass on file descriptor 3: never argv, environment, disk or log; git's output is redacted and the temp repo removed. The agent gets success or failure text (non-fast-forward: "rejected: the remote has changes you don't have; fetch and rebase"). Every run's environment (`GIT_SHELL_ENV`, all levels and legacy agents, host or container) empties git's `credential.helper` through `GIT_CONFIG_COUNT`, sets `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS`/`SSH_ASKPASS=/usr/bin/false`, `GCM_INTERACTIVE=never` and `SSH_AUTH_SOCK=/dev/null`, so a shell push that slips past the `git push` prefix deny (best effort: `sh -c` passes it) finds no host or stored credential; a shell that names a helper itself (`git -c credential.helper=…`) is limited by the sandbox's read denies. The token is set write-only in the project form (or under own accounts) once a repository is listed.

Manifests are validated strictly (`yaml` + `zod`, ADR-0023): unknown keys are errors and every omitted section means "nothing allowed". Filesystem checks resolve symlinks so a link inside an allowed root cannot escape it; shell commands with metacharacters (chaining, substitution, redirects) always need approval.

### 4.7 Workspaces (business branches)

Default layout, configurable:

- `studio` (game dev, Unity), `web-clients` (client web work), `shared/marketing`.
  Each workspace has its own memory namespace, MD vault folder, MCP set and secrets scope. Marketing gets read-only access to the others' public material.

- Projects (ADR-0031): a project level under a workspace for client work: `$ACHORDS_HOME/projects/<slug>/` with `project.yaml` (name, workspace), `PROJECT.md` (client preferences, stack, conventions, deploy rules), `files/` (working folder, managed in Finder by the owner) and an optional `workflow.yaml` replacing the workspace's. Threads carry a project (web chat header, Telegram `/project`), delegated tasks and children inherit it. Project runs get `PROJECT.md`; agents of the project's workspace work in `files/` (cwd and write root), others get the text only. Every folder in an agent's `fs.write` is a work folder for its allowed shell commands too; a run with more than one is told where its shell starts and to change folder with a `cd` of its own (ADR-0061). Project memory lives in `<workspace>/<slug>`. A project may name a `workdir` outside Achords in `project.yaml`; its runs then start there, with `files/` beside it (ADR-0064).

### 4.8 Memory

- **Fast memory**: SQLite (`node:sqlite`, ADR-0022) with FTS5 + `sqlite-vec`. Hybrid retrieval fused with weighted Reciprocal Rank Fusion (semantic ×2; vector hits only within 0.1 cosine of the best, so mere presence earns nothing); trigram keyword index for Hungarian word forms. Separate `memory.db`; without the local embedding model memory falls back to keyword search and vectors are backfilled later. The boss recalls across all workspaces, sub-agents only their own plus `shared`; finished tasks are stored as redacted summaries, except runs that read the open web (ADR-0066): the effective run allows any site (`"*"`), has WebSearch or has full access. A WebFetch limited to a project's own sites (ADR-0057) is not open web. The same definition (`openWeb` in `@achords/policy`) decides the open-web session trust, the skill review (ADR-0049) and the publishing guard (ADR-0038). (Implemented: Phase 2 step 2; tiers, salience decay and the MD vault come later.)
- Tiers: hot / warm / cold / shared. Salience decay (never auto-delete).
- Embeddings computed locally (Ollama embedding model), never sent to frontier providers.
- **MD vault**: per workspace, Obsidian-compatible (frontmatter, `[[links]]`). Holds decisions, daily journals, project notes, skills.
- Daily journal job each evening; pre-compaction save of key decisions.
- Memory graph view in the web UI.

### 4.9 Skills

- Markdown skills with progressive disclosure (index, summary, full body) to save tokens.
- Self-learning: after complex tasks or error recovery, agents propose new skills or targeted patches; the user can require review before a skill is activated.
- Seed skills and scheduled tasks ship from `seed/`; seeding is idempotent and never overwrites local edits.
- Implemented (ADR-0049): `$ACHORDS_HOME/skills/<workspace>/<name>.md` (+ `shared/`), frontmatter `name`, `description`, `enabled`, `source`, `updated`. Every hub run's system prompt lists the visible enabled skills (`- name: description`) and the self-learning rule; bodies only through `skill_read`. `skill_fetch` imports from an https link (public addresses only, redirects re-checked, 200 KB, 15 s, marked untrusted) and names the closest existing skills; `skill_propose` files a new skill or a patch (`skill_proposals`), posted with Approve / Reject (`skill:<verb>:<id>`), changes as before/after with a base hash. Mode per workspace (`skills.mode.<ws>`): review (default) or auto for new skills from runs without open-web access; changes always reviewed. A new skill whose link the owner wrote in the same thread is saved directly. Web: Skills page (table, Add/Edit/Delete, Import from link, proposals, mode).
- Skill folders and agent scopes (ADR-0053): scopes `shared/`, `<workspace>/` and `agents/<agent-id>/` (that agent only; agent scope wins over workspace over shared). In a scope every `SKILL.md` at any depth is a folder skill (scripts and references beside it belong to it) and a `.md` with `name` and `description` frontmatter is a single-file skill; hidden folders and node_modules skipped, 8 levels and 2000 entries per scope, first of two equal names wins with a log warning. Index lines carry the file's absolute path; `skill_read` adds the folder's file list. The visible scope folders are read roots of the run (allow rules, `--add-dir`, read-only container mounts), never write roots. Folder skills are switched on/off from the web (`enabled` in their frontmatter, rest of the file kept) and viewed read-only; Skills page grouped by scope with search.

### 4.10 Scheduler and heartbeat

- Implemented (ADR-0039): `site` and `stuck` monitors in the gateway tick, notify on change only, quiet hours; integration checks with local triage are next.
- Stall watcher (ADR-0066): the gateway tick checks unfinished root chains without a model call (not while paused, draining or in quiet hours). A chain is stalled after N minutes without progress (`stalls.minutes`, default 15) or at a share of its root's budget (`stalls.percent`, default 80; only with a budget). Progress: a run starting, ending or reporting its checklist, a stream event or a claim (kept in the orchestrator's memory), a message in the root's thread (not the boss's or the system's), a card move, a task of the chain created or finished; lease renewal is not. Not stalled: a chain with a claimable task (it waits for the single worker), a chain waiting on the owner, a parked card. A chain whose only blocker is an unanswered `ask_parent` (`waiting_parent = 2`) is stalled. Each stall gets one boss notice in the root's thread: the root stores `stall_noticed_at` and `stall_reason` (migration 0028); an idle notice comes again only after new progress, the spend notice once per root. Thresholds: Settings → Monitors.

- Cron-style schedules stored in SQLite, editable in the UI (list, daily timeline, weekly view). Every run reports a result. Implemented (ADR-0033): own 5-field cron parser in local time; the gateway tick delegates due schedules to their agent like the boss would; results go to the schedule's own thread; missed runs are caught up once, a still-running previous task skips the occurrence; seeds are inserted once, switched off.
- Heartbeat monitors: cheap periodic checks (calendar, mail, kanban, ads metrics) that notify only when something matters. Prefer local models for heartbeat triage.

### 4.11 Kanban

- Workflow per workspace (ADR-0030, planned): `workflow.yaml` with columns, transitions (`by: assignee | role:<x> | owner`, `not: assignee` for four-eyes) and `on_enter` automation (`assign: role:qa`, `approve: owner`). Agents move cards via the `move_task` hub tool only; the owner may drag & drop anything (Pointer Events, touch-friendly), logged. A permission matrix view shows who may do what. A review's verdict is posted in the card's chat, and a card the reviewer sends back to the start column restarts its agent with the findings, at most three times (ADR-0062); then the chat offers the owner two buttons, continue with the last review (past the limit) or accept the card into the column after review, and a resumed session (ADR-0066) is given what other agents, the reviewer above all, posted in the chat since its last turn. A column may need checks: the card enters it only after its agent reported a passing build and tests with `report_checks` (ADR-0065). A column with `on_enter.start: assignee` is a working column (ADR-0066; the seeded workflow sets it on `in_progress`): when the owner (only the owner, never an agent or the system placing a new or reworked card) drops a card there, its agent assignee works on it once: a parked card starts with its budget and stays in that column, a done or failed card gets a successor on the same card (shared root, budget, 20-task limit and sessions), a queued or claimed card is left alone. A refusal (spent budget, task limit, agent checks) is posted in the card's chat. Owner moves are not counted among ADR-0062's restarts.
- Status: implemented in the gateway. Workflows live in `$ACHORDS_HOME/workflows/<workspace>.yaml` (seeded with the default once, never overwritten). Only root tasks get cards; a task given to an agent starts in `start`, a successful run lands in `finish` (review) unless the agent moved the card itself (maintainer decision). `on_enter assign: role:x` hands the card to the first agent of the workspace with that role (not the assignee) as a child task that is told which card to move; with nobody in that role the owner decides. `approve: owner` parks an agent's move and posts Approve/Reject buttons (`move:<verb>:<taskId>`). Every move is logged in `task_moves`; owner moves no rule grants are flagged as overrides. Web drag & drop and the matrix view follow.
- Owner card edits: title/description, a checklist (`task_checklist`) and append-only comments (`task_comments`) per task; the assignee's task prompt lists both. Deleting a card removes the root task with its whole subtree (moves, notes, discussion rooms and their hidden threads go along; the chat stays) and is refused while any task in it is claimed, so a worker never finishes into a deleted task. Steps inside a card cannot be deleted on their own (it would break the parent's wait count). Edits and deletes are logged as gateway log lines, not in `task_moves`.
- Cards made by hand (owner, `POST /api/tasks`): each gets its own thread (titled like the card, with its project), so results, questions and approvals go there as for chat tasks. "Start now" goes through the same delegation as an `@agent` chat message. Otherwise the task is `parked` (migration 0021): the claim query skips it, and `on_enter` automation does not fire for it, until `POST /api/tasks/:id/start` gives it an agent (same policy checks as the boss's delegation), un-parks it and moves it to the workflow's `start` column (logged as an owner move). A card without an agent belongs to its project's workspace, else `shared`.

- Cards created by the user or the orchestrator; AI breakdown into subtasks, swimlanes by owner/priority, per-column WIP limits, card aging.

### 4.12 Dashboard

- Views: team/agents, threads, kanban, schedules, memory graph, usage meters, vault (masked), engine room (settings).
- Usage meters per provider: subscription window utilization or API spend/balance.

### 4.13 Voice

- Telegram voice notes and web mic recordings are transcribed by a local Whisper (`whisper.cpp` / `mlx-whisper`). Browser Web Speech API is not used (it may send audio to third parties).
- Read aloud: the web uses the browser's speech synthesis with on-device voices only (Chrome's network voices would send the text out); Telegram's "🔊 Read aloud" button makes an OGG/Opus voice note on the host (macOS `say`, Hungarian text with Tünde, then ffmpeg) and sends it with `sendVoice`.
- Chat images: web drop/paste (`POST /api/threads/:id/images`, raw body, PNG/JPEG/WebP/GIF up to 5 MB) and Telegram photos or image files are stored in `~/.achords/attachments/<thread>/<uuid>.<ext>` (0600). The message text carries a `[image: <path>]` line per image, so the boss, a direct @agent and delegated work see it without a schema change; runs of that chat get the folder as a read root (also mounted in container runs) and a prompt line to open images with Read. Retention: the gateway deletes chat images older than `attachments.keep_days` (Settings → Storage, default 30, empty = never; by the file's stored time) once per local day from midnight, and removes chat folders left empty.

### 4.14 MCP layer

- MCP client for all integrations, configured from a catalog; credentials resolved from the vault.
- Catalog (ADR-0034): one YAML per integration in `seed/catalog/` (shipped) and `~/.achords/catalog/` (owner; same id wins): command and pinned package, environment (literal or `vault:<id>`, `{project}` for per-client credentials), hosts, `read`/`write` tools. A manifest's `mcp: [ids]` grants them; unknown ids fail the run. Only `read` tools are allowed until publishing review exists; the CLI refuses every other tool of the server (verified against the real CLI).
- Guide: `~/.achords/GUIDE.md` (Settings → Guide; without it the shipped `seed/GUIDE.md`) is put before every agent's and the boss's own instructions in each run's system prompt.
- Full access (ADR-0035, agents without a level): an agent asks with the hub tool `request_access`; the owner approves with a button: once (the task's next run) or for this card (4 hours for the task chain). Then the run gets any website, web search and the write tools of integrations without credentials (Blender, Unity); integrations with credentials leave those runs.
- Shell commands (ADR-0056): a command outside the allow-list is asked for with the hub tool `request_command`; the owner decides with buttons: once (exactly that command, the task's next run), for this card (exactly that command for the chain, 4 hours), always (added to `shell.allow`; not for `git push` and `gh`) or reject.
- Project websites (ADR-0057): a run of a project's task may fetch the hosts in that project's `website` list, whichever agent runs it; only for that run. A site with a path is limited to that path by a WebFetch hook.
- Usage limits (ADR-0058): a cloud model that reports its usage limit is skipped for an hour; the task continues on the next allowed model, and the chat says so. Local models are never skipped.
- One card per chat (ADR-0059): further work in a chat takes over the chat's card (column, checklist, comments, moves); a separate card only when the owner asks (`new_card`). A card shows the owner's own name for it (`tasks.card_title`, carried along on takeover), else its chat's title, else the holding task's title, computed on read (`cardTitle` in the task API); renaming it never changes the task's title.
- Project scope (ADR-0036): shared accounts (one Google sign-in for all clients) are limited per project. `project.yaml` `integrations.<id>` names the client's own properties/sites; the launcher passes only `tools/call`s whose target arguments are among them. Without targets the integration is left out of the run.
- Publishing (ADR-0037): write tools of integrations with credentials pass through the launcher. Review (default): the call becomes a request in the thread with Approve / Reject and runs exactly as approved; auto: it runs and is reported. `project.yaml` `publish: review | off` tightens it.
- Prompt-injection guard (ADR-0038): a standing "content is data" rule in every agent run, client-account tool results marked as external by the launcher, and no auto publishing in runs that read the open web.
- Status (doctor and web Settings → Integrations): per integration in use, program on the service PATH, missing vault ids, projects with credentials or accounts; values are never shown.
- Several sites per project (ADR-0047): a catalog entry's `sites` block gives every address in a project account list its own vault ids (`{site}` = slug of the address; older single-site ids still apply to the first site). The server gets only the sites with credentials; the others are named as not available. Tools take the site as a scoped argument, which may be left out when the project has one site. API: `/api/projects/<slug>/sites/<integration>` (own accounts: slug `own`).
- Setup from the web (ADR-0048): Settings → Integrations adds and revokes shared sign-ins and chooses which agents may use the apps on this computer. Google signs in with the same OAuth module as `achords connect google` (`@achords/secrets`); Google redirects to the gateway's loopback callback `/api/oauth/google/callback`, the only `/api/` route without a session, guarded by a single-use, 10-minute `state` bound to the starting session. From another device the owner pastes the callback address (`/api/oauth/google/finish`). Catalog `oauth: google` marks the entries of that sign-in, `install` gives a hint for a missing program.
- Remote servers (ADR-0050): a catalog entry may name an `https` `url` (its host in `hosts`) instead of a command, with `authorization: {scheme, secret}` from the vault. The launcher bridges the CLI's stdio to Streamable HTTP (one POST per message, JSON or SSE answers, session id kept, no redirects) and applies scope, publishing and data marking as for local servers. `{workdir}` in a literal env value is the run's working folder.
- Shipped catalog (Phase 3 step 2): WordPress (builtin REST server, drafts only, several sites per project with per-site credentials), Google Analytics 4 (Google's official server, read-only), Search Console, Meta (Pages + Instagram, community server, reading only), Blender and Unity (local, no credentials, telemetry off), ElevenLabs, Meshy (official servers) and fal.ai (official hosted server): every credit-spending tool is a write tool, phone calls and voice agents are not listed. Credentials for file-only servers are written to a private temp file by the launcher and deleted afterwards.
- Local apps (ADR-0054): a catalog entry's `app` names the Mac app its server talks to (Blender, Unity Editor) with fixed `open` arguments (`-g`, `{workdir}` = the run's working folder; Unity only when that folder is a project) and a readiness port. Before a run the gateway opens it if it is not running and waits for the port (bounded); on failure the integration is left out with one plain line. Apps Achords opened are quit (AppleScript `quit`) once no queued, running or waiting task needs them for 3 minutes; apps the owner opened are never touched. Agents need no shell to open them.
- Credentials never reach the agent: the launcher fetches the environment with a one-time ticket from `/api/agent/mcp-env` once and starts the real server. Resolution is audited per agent and integration.
  - ADR-0055: for an integration that carries secrets the gateway starts that launcher itself, on the first contact of the run, and stops it with the run; the run's config starts only a relay (`mcp/relay.ts`) with a token for that one server, which carries stdio over `/api/agent/mcp/<id>` (POST per message, one newline-delimited stream back). The secret never enters the run's processes, config, environment or mounts. Integrations without secrets keep the launcher in the run.
  - An agent with a shell gets integrations that carry secrets only in an Apple container (`container: true`, allowed next to a shell since ADR-0055), where the shell cannot reach the gateway's processes. A shell on the Mac next to keys stays refused until runs under a dedicated macOS user exist (ADR-0055 stage 2).
- Default catalog: Google Ads, Analytics, Search Console, AdMob, Google Cloud / Firebase, Meta (Facebook, Instagram), TikTok, Reddit, App Store Connect, Google Play Console, WordPress, ElevenLabs, fal.ai, Meshy, Gmail/Calendar/Drive, Unity MCP.
- The hub also exposes its own MCP server (tasks, threads, memory search) so external clients can drive it, subject to the policy engine.
- Agent runs get the hub's MCP server (and only that, plus catalog servers their manifest allows) with a per-run capability token: `delegate`, `handoff` (ADR-0055), `ask_owner`, `ask_parent`, `answer_child` and `record_room_outcome` (ADR-0066), `spawn_worker`, `propose_agent`, `skill_read`, `skill_fetch`, `skill_propose` (ADR-0049), later `report_progress` (ADR-0029). The caller's identity comes from the token, never from tool arguments.

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
- Implemented (ADR-0051): agents with `*` in `network.allow` run in an Apple container (`container run`, one lightweight Linux VM per run) unless the owner sets `container: false` (web form checkbox, red warning). The claude arguments stay identical; only the run's folders are shared, at their host paths (writable roots read-write, read roots, the per-run MCP config folder and the hub/launcher code read-only); secrets go in with `-e NAME`, never on argv. Subscription runs sign in with a `claude setup-token` token from the vault (`claude-oauth-token`), API runs with the key. The card's session folder for the agent is mounted read-write as the CLI's config folder (ADR-0066). The hub is reached on the container network's host address through a second gateway listener bound to exactly that address (agent API only, subnet-checked, token-authenticated). Image from `seed/container/Dockerfile`, tagged by its hash, built on first need or with `achords container build`. Timeout, cancel, `achords kill` and a restarting gateway stop the VMs by name (`achords-run-<install>-<uuid>`). Claude models only for now; codex and Gemini runs are refused in a container.

### 4.17 Platform layer

- Interface for hardware-specific concerns: local model runtime selection, model size recommendations by RAM, power/idle tuning (model `keep_alive`, unload TTL), Metal/MLX availability checks.
- Implementations: `platform-apple-silicon`, `platform-generic`. Detected at install, overridable.

### 4.18 Remote access and maintenance

- Remote access via Tailscale; ACL limits devices to the dashboard port.
- Updates are **pull-based** (ADR-0043): the service follows the protected public `main` (fast-forward, green CI), installs at an idle moment, self-tests, restarts, and rolls back on any failure; a switch in Settings (default on).
- Optional opt-in maintenance heartbeat sends only version, health and error codes to the vendor's fleet MCP. No inbound access, no agent control, no customer data. There is no endpoint that allows it.

### 4.19 Install

- `achords init`: dependency check, platform detection, provider mode (CLI or API), CLI login handoff, Telegram bot setup, workspace and agent templates, local model pull, service install.
- `achords doctor`, `achords update`, `achords start|stop|status|kill|resume`. `stop` is a planned stop (e.g. before a restart or moving the machine): the gateway starts nothing new, running work may finish (default up to 10 min, `--wait 30m`), then it stops; work still running is interrupted and requeued with a continuation note (the agent's checklist) without losing an attempt (`--now` skips the wait). `kill` remains the emergency stop. `achords container build` builds the image for container runs (ADR-0051). Everything set at install is editable later in the engine room.
- Emergency stop (`achords kill`) must work even if the gateway is hung: it unloads the launchd/systemd service (so `KeepAlive` cannot restart it), kills every agent run's process group (PIDs recorded in `runs`) and this install's run containers (ADR-0051), pauses the task queue and writes a STOP marker the gateway refuses to start past. `achords resume` clears it (details and manual fallback: `docs/OPERATIONS.md`). Telegram `/stop` from the paired owner chat triggers the same path.
- Stop per chat (web, ADR-0052): cancels one chat's queued and running tasks and kills only their runs' process groups with the same core code; the queue stays on.
- Refused tool calls: a Claude run's `permission_denials` and its error tool results that say approval is needed, permission was denied or the sandbox blocked the call are stored redacted per run (`runs.denials`, at most 20, input capped at 500 characters), logged one line each by the gateway and listed per run in the chat's run details next to Stop (ADR-0052).

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
