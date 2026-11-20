# ADR-0036: Project scope for shared integration accounts

Status: Accepted (2026-11-20)

- Context: Agency access (ADR-0034) uses one owner account per service: clients grant the owner's Google account access to their GA4 property and Search Console site, so one sign-in reaches every client. An agent working for client A could then read client B's data; telling it in the prompt is a request, not a limit.

- Decision:
  - **Targets per project.** `project.yaml` gets `integrations: { <catalog id>: [<own values>] }`, e.g. `ga4: ["324490876"]`, `search-console: ["sc-domain:example.com"]`. The web project editor keeps the field.
  - **Scope per catalog entry.** An entry may declare `scope: { args, free, strip }`: the tool arguments that name a client target (`property_id` for GA4; `site_url`, `site_urls` for Search Console), tools allowed without such an argument (`free`), and a prefix ignored when comparing (`properties/`).
  - **Enforced in the launcher.** For a scoped integration the launcher sits between the agent CLI and the MCP server and reads each JSON-RPC line. A `tools/call` passes only when every target argument is one of the project's values; a call without one (e.g. "list every account") is refused unless the tool is free; batches are refused. Refusals are tool errors the agent sees; the server never receives the call.
  - **No targets, no integration.** A scoped integration is left out of a run without a project or whose project names no targets; the prompt says why. The run itself goes on.
  - The prompt names the project's targets so the agent uses them directly.

- Consequences: Cross-client reads need an explicit project entry, the cheapest place for the owner to state which data belongs to whom. Owner-wide overviews across clients are not possible through agents for now. WordPress needs no scope (per-project credentials); Meta gets one when its token is set up and its tool arguments are checked.
