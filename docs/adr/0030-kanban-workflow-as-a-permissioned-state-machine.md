# ADR-0030: Kanban workflow as a permissioned state machine

Status: Accepted (2026-11-19)

- Context: The kanban must encode process rules, e.g. a dev agent may not move its own work to Done/Deployed; a QA agent tests it first; deployment needs the owner. Per-agent flags would mix capabilities (what an agent can do) with process (who may advance work), and break whenever agents are added.
- Decision: Each workspace has a `workflow.yaml`: ordered `columns`, allowed `transitions` (`from`, `to`, `by`: `assignee`, `role:<name>`, `owner`; optional `not: assignee` for four-eyes checks), and `on_enter` automation (`assign: role:<name>` delegates via ADR-0029; `approve: owner` asks for a button approval). Agents get a `roles` list in `agent.yaml`. Agents move cards only through a `move_task` hub tool checked against the workflow; anything else is refused. The owner may move any card (drag & drop on the web, Pointer Events, works on touch); owner overrides are logged. The web shows the workflow as a column × role permission matrix (read-only first).
- Consequences: Capabilities stay in `agent.yaml`, process in `workflow.yaml`; adding a QA agent means giving it the `qa` role. The current status-derived kanban columns are replaced by workflow columns (migration). Default workflow is seeded per workspace and never overwritten.
