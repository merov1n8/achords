# ADR-0034: MCP catalog and integration credentials

Status: Accepted (2026-11-20)

- Context: Phase 3 connects agents to outside services (WordPress, Google, Meta, Blender, Unity, …) through MCP servers (ADR-0019). Agents must get only the integrations their manifest lists (ADR-0010), credentials must never reach the agent (ADR-0011, ADR-0012), and the owner's own Claude connectors stay out of agent runs (ADR-0024).

- Decision:
  - **Catalog.** One YAML file per integration: shipped entries in `seed/catalog/<id>.yaml`, owner entries or overrides in `~/.achords/catalog/<id>.yaml` (same id: the owner's file wins). An entry names the MCP server command and arguments (ecosystem packages pinned to an exact version), its environment (literal values or `vault:<id>` references; `{project}` in a vault id is replaced by the task's project slug, so each client can have its own credentials), the hosts it talks to (documentation and doctor checks), and its tools split into `read` and `write`.
  - **Manifest.** `mcp: [<catalog id>, …]` grants an integration to an agent. Unknown ids fail the manifest check. Only `read` tools are allowed (`mcp__<id>__<tool>`) until publishing review exists (Phase 3 step 3); every other tool of the server is refused by the CLI's deny-by-default permissions.
  - **Per-run config.** Catalog servers go into the same per-run MCP config file as the hub server (0600, deleted after the run, `--strict-mcp-config`). Workers and room turns get none.
  - **Credentials through a one-time ticket.** The config file never contains secrets. It starts a small launcher with a single-use ticket; the launcher fetches the resolved environment from the gateway (`/api/agent/mcp-env`), the ticket is then dead, and the launcher starts the real server with that environment. Every resolution is audited in the vault (`agent:<id>/mcp:<server>`), and secret values are covered by redaction.
  - **No shell next to secrets.** A process of the same user can read another's environment, so an agent with a shell (`shell:` in its manifest) is refused integrations that carry secrets. Local integrations without secrets (Blender, Unity) are allowed with a shell.
  - **Credential files and builtin servers.** Servers that only read credentials from a file (Google) get `files:`: the launcher writes a private JSON file (0600, private temp folder) with the resolved fields, passes its path in the named variable and deletes it when the server exits; agents cannot read it because their file tools are limited to their own folders. Small servers shipped with achords (`builtin:`, e.g. WordPress over the core REST API, so client sites need no plugin) run on the gateway's Node.
  - **Ecosystem first.** Where a maintained MCP server exists it is used, pinned and reviewed; thin own servers only where none is trustworthy.

- Consequences: Adding an integration is a YAML file plus vault secrets, no code. Network allow-listing of MCP servers is not enforced yet (no containers, Phase 3 decision C); the catalog's `hosts` document the intent. Write tools stay unusable until step 3 lands.
