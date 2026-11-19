# ADR-0010: Policy engine with declarative agent manifests

Status: Accepted (2026-11-19)

- Decision: `agent.yaml` declares models, tools, MCP, fs, shell, network, budget, publish mode. Deny by default.
- Consequences: Agents cannot act outside role (e.g. Unity agent cannot post marketing).
