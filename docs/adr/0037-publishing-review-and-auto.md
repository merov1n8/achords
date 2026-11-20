# ADR-0037: Publishing through the launcher: review and auto

Status: Accepted (2026-11-20)

- Context: ADR-0020 set `publish_mode: review | auto` per agent and channel; ADR-0034 kept integration write tools unusable until it exists. Outward actions on client systems (WordPress drafts, Meta posts, Search Console submissions) must run only as the owner approved them, and the agent must not be able to bypass that.

- Decision:
  - **Scope.** Write tools of integrations with credentials. Local integrations (Blender, Unity) stay under ADR-0035.
  - **Mode.** Channel = integration id. `publish_mode.channels[<id>]` or `publish_mode.default` (review by default); `project.yaml` `publish: review | off` can only tighten it. `off`: the write tools are not granted at all.
  - **Enforced in the launcher.** For review and auto the write tools are granted to the CLI, and the launcher (ADR-0034/0036) sits on the stdio stream. Review: a `tools/call` of a write tool never reaches the server; the launcher posts it to `/api/agent/publish` with a run token that only grants `publish:<id>` (dies with the run), and the agent gets "sent for approval". Auto: the call goes through and its result is posted to `/api/agent/publish_log`.
  - **Owner decision.** The request (tool and full arguments, long content shortened in the message) is posted in the task's thread with Approve / Reject (Telegram and web). Approve runs exactly the stored arguments once, through the same launcher with a fresh ticket and the project's scope; the setup is checked again at that moment (tool still a write tool, mode not off). Secrets are resolved as `owner-approved:agent:<id>/mcp:<id>`. The result is posted in the thread.
  - The agent is not resumed with the outcome; its report says what it sent, the thread shows what happened.

- Consequences: Agents can prepare and hand over real changes without holding the power to make them. An "Edit" step is not built: the owner rejects and tells the agent what to change. Very long content is shown shortened in the chat message.
