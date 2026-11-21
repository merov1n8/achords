# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- Forms in modals (e.g. Projects → Edit) closed when a text selection started in a field and the
  mouse was released outside the modal; only a real click on the backdrop closes them now.
- Pinned chats show the pin icon of the app instead of an emoji.
- Auto-update stopped at "pnpm install" (an undecided build-script setting that pnpm 12 treats as
  an error) and then retried and notified every few seconds. The setting is decided, and a failed
  update is now tried once per commit (again with "Check now" or when a newer commit lands); the
  failing step's output goes to the gateway log.
- A missing account or credential for one integration no longer fails the whole task: that integration is left out of the run and the agent is told why (e.g. social posting to Facebook while your own WordPress address is not set).
- The live progress bar no longer slides over the chat box while an agent is working.
- WordPress links were shown as [REDACTED]: the site address is not a secret, so it now comes from the project's accounts (channel `wordpress`) instead of the vault.
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

- The product is written Achords in the web UI, notices and docs. The agent list shows the name
  with @id under it instead of a separate id column.
- The Chat page has its own chat list column (search, Recent / By project, pin, rename, archive,
  delete, All chats) instead of the list in the sidebar; Chat in the sidebar is a plain menu item.
  Each chat in the list shows the agent that answered last and how long ago.
- Modals close after a successful save (project edit, WordPress logins, sign-in tokens, Google
  sign-in). Agent workflow roles are checkboxes of the roles the workflows use, plus your own.
- Agents have an Effort setting (low to max): passed to Claude as `--effort`, to OpenAI models as
  reasoning effort (up to high); Gemini ignores it.
- Agents → Edit opens the same form as New agent, filled in: name, role, workspace, scope
  (AGENT.md), workflow roles, models, tools, folders, shell, network, delegation and budget.
  Settings the form does not show (integrations, publishing) are kept.
- Appearance keeps one background per mode (warm light, graphite dark); only the accent colours
  are chosen. Adding a secret in the vault asks just for its id and value.
- Phones: a bottom tab bar (Chat, Kanban, Agents, Monitors, More) and a "More" sheet with the
  other pages and Settings replace the slide-in sidebar; the top bar shows the page title. The
  kanban shows one column at a time with a column switcher.
- Settings → Integrations is grouped: shared sign-ins (Google, Meta) first, then your own pages and
  sites, then per-client logins and the apps on this Mac. Projects and the vault use the same
  pattern: a table, Add at the top right, add and edit in a modal. WordPress sites are managed in
  one place (Projects → Edit, or your own accounts), no longer also as an account row. Adding a
  secret offers what the integrations still miss.
- Web UI redesign: Geist fonts, new design tokens with three light and three dark backgrounds and
  four accents per mode (Settings → Appearance), a sidebar that collapses to an icon rail, the
  new achords mark and favicon, and summary boxes on the Usage page.
- Web UI: Schedules, Monitors and Agents are a table with an Add button at the top right; adding
  and editing happen in a modal (monitors can now be edited too). Delete asks first in a small
  dialog (schedules, monitors, chats, devices). Agent room transcripts open in a modal.
- Schedules: a Repeat picker (every hour, every day, weekdays, weekly on chosen days, monthly,
  or Custom cron) instead of a raw cron field; the list says "Weekdays at 09:00" instead of
  `0 9 * * 1-5`. Existing schedules open in the picker when their cron fits it, else as Custom.
- Chat: the … menu of a chat is a small popover with an icon per action (pin, rename, archive,
  delete), usable from the keyboard; rename and delete open a dialog.
- The hub's own MCP server (delegate, ask_owner, …) runs on the official MCP TypeScript SDK (`@modelcontextprotocol/server`) instead of a hand-written JSON-RPC loop; same tools, same run tokens.

- Sub-agents write their final report in the language the owner uses with the boss.

### Added

- Blender and the Unity Editor are opened by achords when a run needs them and they are not
  running, and closed again a few minutes after the last task that needs them has finished. Apps
  you opened yourself are never closed. Agents no longer need a shell command to open them, so
  they can also use keyed integrations such as Meshy. If an app cannot be opened, the run goes on
  without it and says so.

- Skill folders and agent skills (ADR-0053): skill packs installed under `skills/` (a folder per skill with `SKILL.md`, scripts and references, nested in category folders) are found automatically, as are single `.md` skills with a name and description in their frontmatter. Skills under `skills/agents/<agent-id>/` are seen only by that agent. Agents get the path of each skill and may read its folder (never write it) and run its scripts with their allowed commands. The Skills page groups skills by Shared, workspace and agent, has a search, switches installed skill folders on or off and shows them read-only.

- Agents with `*` (any website) in their network list run in an Apple container: a small Linux
  virtual machine that sees only the agent's own folders, not the rest of your Mac (ADR-0051).
  On by default; the agent form has a "Run in an Apple container" checkbox under the network list
  with a warning when switched off. Needs Apple's `container` tool (`brew install container`)
  and, for Claude on the subscription, a token from `claude setup-token` in Settings → Model
  access → Claude → "Token for container runs". Claude models only for now. The image builds by
  itself on first use or with `achords container build`; `achords kill` stops running
  containers too.
- Run details next to each chat: how many of the chat's agents are working, the tokens and cost
  of its runs (with your daily API budget, if set) and every agent with running, waiting, queued or
  idle. On narrower screens they open from the info button. **Stop run** cancels the chat's queued
  and waiting tasks and stops its running agents at once (as the emergency stop does, but only for
  this chat). Buttons above the message box address one of the chat's agents directly (@agent).
- Phones: an opened chat fills the screen with a back button, a live status line ("1 of 3 agents
  working · $0.41") and a thin progress line; the info button opens the run details from below.
- ElevenLabs (voices, speech, sound effects, music), Meshy (3D models) and fal.ai (image, video
  and audio models) as integrations: Settings → Integrations → **Add sign-in**, paste the API key.
  Anything that costs credits (generating, cloning a voice, downloading a model) waits for your
  approval in the chat, or runs and is reported there when the agent's publish mode is `auto`.
  Phone calls and ElevenLabs voice agents are not available. Generated audio lands in the agent's
  working folder. fal.ai is reached directly over HTTPS, nothing to install.

- Skills: short how-tos your agents follow (Skills page in the sidebar and in the phone's More menu). Agents see each skill's name and description and read the full text when they need it. After a task that took several attempts or a correction from you, an agent can propose a new skill or a change; you get it in the chat with Approve / Reject, changes shown as before and after. Per workspace you can let new skills be saved automatically; changes always wait for you. Send a link in chat ("found a good skill, build it in") and it is built in directly, or proposed as a change to a similar skill you already have. On the Skills page you can also add, edit, switch off, delete and import skills from a link yourself. Two starter skills ship: writing the final report in plain language, and a self-check before reporting done.

- Settings → Integrations can set up everything that needed the terminal before: **Add sign-in**
  connects Google (choose the Desktop-app client JSON, then sign in in a new tab; from a phone or
  another computer paste the address of the page Google ends on) or takes a token for Meta and
  other shared services; **Revoke** removes a sign-in after a confirmation. **Add app** chooses
  which agents may use Blender or Unity and shows whether the program is installed; **Edit** and
  **Remove** on each row. The CLI commands keep working.

- Kanban: a "New card" button (top right) to make a card by hand: title, description, and
  optionally an agent, a project and the column. With "Start now" the agent begins right away;
  otherwise the card shows "Not started" and no agent touches it until you press Start in the
  card (pick an agent there if it has none). Every card gets its own chat, where results,
  questions and approvals appear.
- Kanban: opens on "All" workspaces with the assignee on every card; all columns fit the screen.
  A click (or Enter) opens a card: edit title and description, move it, keep sub-items and your
  own comments (the agent sees them next time), or delete it after a confirmation.
- Kanban cards can be edited and deleted (gateway API; the web view follows): change a card's title and description, keep a checklist on it and leave your own comments. The agent working on the card sees the checklist and comments. Deleting a card removes it with all its steps; a card that is running is not deleted (stop it first or wait until it finishes).
- Several WordPress sites per client (or for your own accounts): list every site address in the project, and give each its own WordPress user and application password in the vault (`wordpress-user-<project>-<site>`, `wordpress-password-<project>-<site>`). Agents name the site they work on; with one site they need not. A site without credentials is left out and the agent is told; the others keep working. Existing single-site projects keep their old credentials. The connection test checks every site and says which still need credentials.
- Spend: the Usage page shows today's and this month's cost by provider, agent or project, with API money apart from subscription estimates. Settings → Model access sets a daily and monthly API budget per provider: a note at 80%, and at 100% new API work waits until the next day or month (or until you raise it). Models without a reported cost are priced from ~/.achords/pricing.yaml.
- Google Gemini (first stage, not tried live yet): agents can run on Gemini models through the official gemini CLI (`cli-gemini/<model>`), on your Google login or an API key (Settings → Model access). For now Gemini runs edit only their own folders, run no shell commands and get no achords tools or integrations.
- Model access (Settings): Claude and OpenAI can each run on your subscription or on an API key; the key is kept in the vault and given only to that provider's runs, and switching back needs no new sign-in. Not yet tried with real API keys.
- Automatic updates (Settings → Updates, on by default): achords checks its public main branch every hour, takes a new version only when the automatic tests passed, installs it when no agent is working, and goes back to the previous version by itself if the new one does not build or start. You get one line about what changed.
- Your own accounts (Settings → Integrations): pages, properties, sites and your own WordPress for work that has no client project. Google and Meta sign-ins were already shared by everything; now your own business can use them too, while a client project still only reaches that client's accounts.
- Talk to an agent directly: a message starting with @agent (e.g. "@social write a post about…") goes straight to that agent, without the boss, in the web chat and on Telegram; the agent answers in the same chat.
- OpenAI agents, second stage: runs on GPT models can now delegate, ask you and use Blender and Unity, and they only read their own folders (your home folder, SSH keys and the codex login are off limits); client integrations with credentials stay with Claude-run agents. Checked with live codex runs.
- Change agents by asking: tell the boss "give social access to Meta" or "let web-dev read the WordPress docs"; it posts the exact change in plain words (+ meta, − npm test) with Approve / Reject, and only an approved change is written to agent.yaml, keeping your comments. A proposal made before you edited the file by hand is refused.
- Test connection on Settings → Integrations: one read call through the same path agents use (for client integrations with a chosen project, e.g. its GA4 property or Facebook page) shows whether the credentials and accounts work.
- All chats: a checkbox in the table header selects every chat shown.
- Integration monitors: watch a read call of an integration (e.g. new comments on a Facebook page, Search Console queries) every N minutes; when the result changes, the local model decides whether it is news by your own question ("a new review under 4 stars") and tells you in one or two sentences. Unchanged results cost nothing and use no quota.
- OpenAI models: any agent can run on GPT models through the official codex CLI (`cli-codex/<model>`, e.g. gpt-6.2-astra, gpt-6.2-sol); pick them per agent on the Agents page. For now such runs work with their own files only (no delegation, questions or integrations), and a used-up subscription limit makes the task wait instead of fail.
- Many chats: the sidebar chat list scrolls on its own and has a search box, Pinned / Recent / Scheduled groups, and a By project view with the latest 5 chats per project. Each chat has actions: pin, rename, archive (hidden, restorable) and delete. A new All chats page filters by project, text and archived, and archives several at once. The Telegram chat can be archived but not deleted.
- Monitors (new page): cheap checks every few minutes that only speak up when something changes: a website goes down or comes back, or a kanban card has not moved for too long. Notes go to your Telegram chat, with optional quiet hours (e.g. 22-7) after which waiting news is delivered.
- Prompt-injection guard: every agent is told that what it reads (web pages, comments, posts, search queries, files) is data and never instructions; results from client accounts arrive marked as external content; and an agent that reads the open web never publishes automatically, its posts always wait for your approval.
- Publishing messages are written for people: an approval request shows the post itself (title, text without HTML, other fields as plain lines) instead of JSON, the result is one sentence with a link ("Saved as a draft. Open it: …"), and a task that sent something for approval ends with a single line instead of repeating it.
- Credentials from the web: a project's WordPress connection (address, user, application password) can be set in the project editor, and missing integration secrets (e.g. the Meta token) right on Settings → Integrations. Values go to the vault and are never shown again.
- Meta is limited per client like Google: the page and Instagram account IDs in a project's facebook and instagram accounts are the only ones agents can use there.
- Publishing with approval: agents can now use the write tools of client integrations (WordPress drafts, Meta posts, Search Console submissions). By default every such action is posted in the conversation with Approve / Reject and runs only as approved; `publish_mode` in agent.yaml can set a channel to auto (runs and is reported), and `publish: review` or `publish: off` in a project's project.yaml can forbid it for that client.
- Integration checks: `achords doctor` and the new web page Settings → Integrations show, for every integration an agent uses, whether its program is on the service's PATH, which vault secrets are missing, and which client projects are set up, each with the fix.
- Client accounts in the web project editor: social pages, ad accounts, Analytics properties, Search Console sites and websites, several per channel. Agents of the project see them; Google Analytics and Search Console entries also set what agents may query (ADR-0036).
- Client separation for shared accounts: in `project.yaml`, `integrations: { ga4: ["<property id>"], search-console: ["sc-domain:<site>"] }` names the client's own data. Agents working on that project can only query those; requests for other clients are refused before they reach Google. Without these entries Analytics and Search Console are not offered in the run.
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
