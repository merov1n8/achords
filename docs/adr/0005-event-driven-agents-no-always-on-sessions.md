# ADR-0005: Event-driven agents, no always-on sessions

Status: Accepted (2026-11-19)

- Decision: Always-on gateway only; agent runs are spawned per task and exit. Local models unload after TTL.
- Consequences: Near-zero idle cost; seconds of cold start (more for local model load).
