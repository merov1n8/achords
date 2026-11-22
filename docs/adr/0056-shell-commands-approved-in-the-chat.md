# ADR-0056: Shell commands approved in the chat

Status: Accepted (2026-11-22)

- Context: An agent's shell runs only the commands in its `shell.allow` (prefixes, extra arguments allowed). Anything else is refused by the CLI in print mode ("requires approval") with nobody to approve it: the agent asked in the chat, the owner said yes, and the next run was refused again, because a yes in the chat changes no permission. Full access (ADR-0035) opens the web and local integrations, not the shell. Owner decision (2026-11-22): the agent asks for a command and the owner decides with buttons in the chat (web and Telegram): this task, always, or reject.

- Decision:
  - **Hub tool `request_command`** `{command, reason}`, given to Claude runs of agents with `Bash` and a `shell` (not codex or Gemini runs, which take no per-command rules; not discussion turns or workers). The command must be one plain command: the same metacharacter check as `checkShell` (no `;`, `|`, `$`, redirects, globs, line breaks), at most 300 characters, whitespace collapsed. A command the allow-list already admits is refused with "already allowed". The request is stored (`pending_cmd:<id>`), posted to the task's thread with buttons, and the task waits like for a question (ADR-0029).
  - **This task.** The exact command is allowed for the task chain (root id) for 4 hours, like full access: the run gets `Bash(<command>)` (exact match, no extra arguments) and one prompt line naming it. Nothing is written to agent.yaml.
  - **Always.** The command is added to the agent's `shell.allow` (patched like an agent change, ADR-0041, layout and comments kept). As every allow-list entry it is a prefix from then on.
  - **No "always" for `git push` and `gh`.** They act beyond this machine with the owner's GitHub login; as a prefix, `git push origin x` would also admit `--force` or `--delete`. They are only allowed one exact command for one task; the button is not shown and the action is refused if sent anyway.
  - **Reject** resumes the task with the refusal as the owner's answer. Every decision clears the buttons; a second press finds no pending request.

- Consequences: The owner sees the exact command before it runs and can keep agents' allow-lists short. An agent outside a container (no `container: true`) runs approved commands with the owner's user and logins: approving `git push` lets it push wherever that login can. Workers and discussion turns never ask. Codex and Gemini runs cannot ask yet; their shells keep their own rules.
