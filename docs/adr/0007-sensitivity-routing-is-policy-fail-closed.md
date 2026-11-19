# ADR-0007: Sensitivity routing is policy, fail-closed

Status: Accepted (2026-11-19)

- Decision: Data/workspaces tagged `local-only` always go to local models; no fallback to frontier.
- Consequences: Some tasks wait when the local model is unavailable.
