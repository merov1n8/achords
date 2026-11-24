# ADR-0069: Notes to running work

Status: Accepted (2026-11-24). Amends ADR-0025, ADR-0037 and ADR-0066.

- Context:
  - Agents post nothing while they work, and the owner's messages reach only the boss. A run cannot be corrected while it is running. Anything the owner writes waits until the run ends, or worse, becomes new work: on 2026-11-24 a "is it stuck?" message during a silent 14-minute run gave the same work out twice.
  - The result of a request the owner approved during a run (ADR-0037: a publish or a Unity query) was posted in the chat but never reached the agent that asked.

- Decision:
  - **A note.** A message the owner sends to the work running on a card. It is a card comment with `kind = note`, the task it was sent to (`for_task`) and `delivered_at`.
    - Chat (web and Telegram): the boss decides. While the chat's card has a running task, its decision has the action `note_running` for a message that adds to or corrects that work. The owner's words go into the note verbatim. `@agent` keeps its meaning (new work for that agent).
    - Board: a comment added to a card whose task is running is a note.
  - **Delivery through hooks.** The gateway writes each note as its own file in `$ACHORDS_HOME/run/inbox/<task>/` (0600, outside every run's folders). Both CLIs run `apps/gateway/hooks/inbox.mjs` as their `PostToolUse` and `Stop` hooks:
    - after a tool call, the notes reach the model before its next step (`additionalContext`);
    - when the agent is about to finish, a waiting note makes it continue (`decision: block`).
    - The hook claims each note file with an atomic rename. The gateway marks the claimed notes delivered and tells the chat.
    - Claude takes the hooks in `--settings`. Codex takes them through `-c hooks.*` with `--dangerously-bypass-hook-trust`: the only hooks are Achords' own script, and the user's config is ignored (ADR-0040).
    - Container runs and Gemini get no hooks yet: their notes wait for the end of the run.
  - **Not delivered.** A note still unclaimed when the run ends is not acted on by itself. The chat says so, with two buttons:
    - "Continue with the note": a successor task on the card with the note, which resumes the card's session (ADR-0066);
    - "Drop it": the note stays on the card and is left out of later prompts.
  - **Results of approved requests.** When an owner-approved request finishes, its result becomes a card comment (`kind = request_result`), marked as external data (ADR-0038). If the asking task is still running, it is delivered like a note. Otherwise the next turn on the card reads it.

- Checked on 2026-11-24 (claude 2.1.331, codex 0.167.0), with real CLIs and scripts like `inbox.mjs`:
  - `claude -p` with hooks in `--settings`: `PostToolUse` `additionalContext` reached the model, and `Stop` with `decision: block` made it continue (`stop_hook_active` true the second time).
  - `codex exec --ephemeral --ignore-user-config` with `-c hooks.PostToolUse` and `-c hooks.Stop`: the same results. This held also under a permissions profile that denies the home folder: hooks run outside the sandbox and could write there.
  - The bypass flag adds two `item.completed` events of type `error` (warnings) to the stream. They are not top-level errors and do not fail the run.

- Consequences:
  - The owner can steer a long run without restarting it, and an approved query's answer reaches the agent that needs it.
  - Hooks run unsandboxed with the owner's rights in both CLIs. The script only lists, renames and reads files in the one folder it is given. No run can write that folder, so an agent cannot forge a note.
  - A note arrives only at a tool call or at the stop: an agent thinking for a long time without tools sees it later.
