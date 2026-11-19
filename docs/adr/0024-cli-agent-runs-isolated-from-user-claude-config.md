# ADR-0024: CLI agent runs are isolated from the user's Claude config

Status: Accepted (2026-11-19)

- Context: A probe of `claude -p` (v2.1.x) showed that `--tools ""` only removes built-in tools: the user's claude.ai connectors (Gmail incl. send, Drive, Asana, ...) stayed available, and the user's personal hooks ran. That breaks deny-by-default (ADR-0010).
- Decision: The `cli-claude` adapter always passes `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (no MCP servers unless the hub adds them from the policy), `--setting-sources ""` (no user/project settings or hooks), `--tools` with exactly the manifest's tools, `--no-session-persistence`, and the prompt on stdin (never argv). Runs get their own process group.
- Consequences: Agents only get what their manifest grants; MCP access will be added explicitly per run by the MCP layer. The owner's personal Claude Code setup has no effect on agents. Verified against the real CLI (opt-in test `ACHORDS_TEST_CLAUDE=1`).
