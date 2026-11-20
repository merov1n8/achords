# ADR-0040: OpenAI models through the codex CLI

Status: Accepted (2026-11-20), first stage

- Context: The owner wants to choose per agent, and switch per task, between Claude and OpenAI models (ADR-0004: official subscription CLIs, `claude` and `codex`). Codex's permission model is coarser than Claude Code's: no per-file read rules, no per-host fetch rules, no per-command shell allow-list; it has a sandbox (read-only, or writes to the workspace and extra folders) and network on/off. Its MCP configuration is passed as config overrides, which would put run tokens and tickets on the command line.

- Decision (first stage):
  - Provider `cli-codex`: `codex exec --json --ephemeral --ignore-user-config --ignore-rules`, prompt on stdin (role and rules first, as Codex has no system-prompt flag), final answer and output schema through private temp files, own process group for timeout/cancel/kill. Never touches the CLI's login.
  - Sandbox from the run's tools: writing tools (Edit, Write, Bash, …) → `workspace-write` limited to the agent's folders; otherwise `read-only`. Network only for runs with owner-granted open web (ADR-0035).
  - **No achords MCP tools in codex runs yet**: no hub tools (delegate, ask_owner, …) and no integrations; nothing is resolved from the vault. The prompt says so; the agent reports open questions instead.
  - A subscription limit ("usage limit … try again at") is `unavailable`: the task is retried later, like a local model server that is down.
  - Models are `cli-codex/<slug>`; the web suggests the codex CLI's own listed models.

- Consequences: Any agent can run on Claude or OpenAI models by the owner's choice. Codex's read-only sandbox may read beyond the agent's folders (to be measured); its runs see less of achords until the second stage passes MCP servers without exposing tokens on the command line (verified against the real CLI).
