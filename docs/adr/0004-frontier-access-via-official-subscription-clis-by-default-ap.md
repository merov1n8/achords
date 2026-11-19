# ADR-0004: Frontier access via official subscription CLIs by default, API as first-class option

Status: Accepted (2026-11-19)

- Context: Owner uses subscription CLIs. Anthropic terms on subscription use in third-party tools changed during 2026 and remain ambiguous.
- Decision: CLI adapters invoke only the official binaries (`claude`, `codex`); never handle OAuth tokens. API-key adapters ship in the same interface. Mode chosen at install, switchable in the engine room.
- Consequences: Usage meters differ per mode (window utilization vs spend/balance). Product is not marketed on "use your subscription". Legal review before commercial distribution.
