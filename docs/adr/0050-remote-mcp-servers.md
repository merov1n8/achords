# ADR-0050: Remote MCP servers over Streamable HTTP

Status: Accepted (2026-11-21)

- Context: Catalog entries start a local stdio server (ADR-0034). Some official servers are only hosted, e.g. fal.ai at `https://mcp.fal.ai/mcp` (Streamable HTTP, API key in the `Authorization` header). The agent CLI could reach such a URL itself, but then the key would sit in the per-run config file and the launcher could not enforce scope, publishing review (ADR-0037) or data marking (ADR-0038). A stdio bridge package (`mcp-remote`) would add an unpinned dependency chain for about a hundred lines of code.

- Decision:
  - A catalog entry names exactly one of `command`, `builtin` or `url`. A `url` must be `https` on a host listed in the entry's `hosts`. `authorization: {scheme, secret}` (secret a `vault:` id) becomes the header `Authorization: <scheme> <secret>`; it counts as the entry's secret like `env` values (status, revoke, no shell).
  - The gateway resolves the header into the launch (`remote: {url, headers}`); the launcher fetches it with its one-time ticket as before and, instead of starting a process, sends each JSON-RPC line from the CLI as one POST (`Accept: application/json, text/event-stream`), keeps `Mcp-Session-Id` and `MCP-Protocol-Version`, and passes every message of the JSON or SSE answer back as one line. Requests leave in order; redirects are refused so the key only reaches the catalog's host. An HTTP or network error becomes a JSON-RPC error for that request. No server-initiated GET stream.
  - The same proxy path as local servers applies: scope, review/auto publishing, data marking. Owner-approved calls and connection tests go through the launcher too.
  - `{workdir}` in a literal env value is the run's working folder (agents of a project: its `files/`), so a server's output lands where the agent can read it; outside a run the owner's own work folder. Launches for a run (and owner-approved calls of that run) also start the server in that folder, so files a server saves relative to its working directory land there too.

- Consequences: Hosted servers need no install and no new dependency. The `hosts` of a remote entry are enforced for the server address (not for files it returns). Server-to-client requests over a GET stream (sampling, elicitation) are not supported; servers that need them will not work.
