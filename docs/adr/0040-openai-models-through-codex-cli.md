# ADR-0040: OpenAI models through the codex CLI

Status: Accepted (2026-11-20), stage 2 (2026-11-21)

- Context: The owner wants to choose per agent, and switch per task, between Claude and OpenAI models (ADR-0004: official subscription CLIs, `claude` and `codex`). Codex's permission model is coarser than Claude Code's: no per-file read rules, no per-host fetch rules, no per-command shell allow-list; it has a sandbox (read-only, or writes to the workspace and extra folders) and network on/off. Its MCP configuration is passed as config overrides, which would put run tokens and tickets on the command line.

- Decision (first stage):
  - Provider `cli-codex`: `codex exec --json --ephemeral --ignore-user-config --ignore-rules`, prompt on stdin (role and rules first, as Codex has no system-prompt flag), final answer and output schema through private temp files, own process group for timeout/cancel/kill. Never touches the CLI's login.
  - Sandbox from the run's tools: writing tools (Edit, Write, Bash, …) → `workspace-write` limited to the agent's folders; otherwise `read-only`. Network only for runs with owner-granted open web (ADR-0035).
  - **No achords MCP tools in codex runs yet**: no hub tools (delegate, ask_owner, …) and no integrations; nothing is resolved from the vault. The prompt says so; the agent reports open questions instead.
  - A subscription limit ("usage limit … try again at") is `unavailable`: the task is retried later, like a local model server that is down.
  - Models are `cli-codex/<slug>`; the web suggests the codex CLI's own listed models.

- Stage 2 (verified against codex 0.167 with a live model run):
  - Measured: codex's built-in `read-only` and `:workspace` sandboxes read the whole disk, including the home folder and `~/.ssh`. Runs therefore use a permissions profile instead of `-s` (which would override it): `/` readable, the user's home denied, except the run's own folders (from its scoped Read/Edit rules; write where it may write), PATH folders under home (tools like ffmpeg) and codex's own packages (it re-runs itself in the sandbox; `~/.codex/auth.json` stays denied). Network is the profile's `network.enabled`, on only with owner-granted open web. Writing outside the run's folders, `/tmp` included, is refused.
  - MCP: the per-run servers become `mcp_servers.<id>` config with `enabled_tools` = the tools granted to the run and `default_tools_approval_mode = "approve"` (the gateway decides; codex's `never` policy would otherwise refuse every call). Tokens and tickets never go on the command line: they are set in the codex process environment under a per-server name, forwarded with `env_vars`, named to the server through `<NAME>_VAR`, and excluded from the agent's shell (`shell_environment_policy.exclude`, every forwarded name). The hub server and the launcher read that indirection.
  - Codex runs get hub tools (delegate, ask_owner, …) and integrations without credentials. Integrations with credentials stay out, as for any agent with a shell (ADR-0034).

- Consequences: Any agent can run on Claude or OpenAI models by the owner's choice. Codex's permission profiles are marked beta upstream; a codex update is re-checked with the live probe before it is used.
