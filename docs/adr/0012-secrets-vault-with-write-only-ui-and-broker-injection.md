# ADR-0012: Secrets vault with write-only UI and broker injection

Status: Accepted (2026-11-19)

- Decision: Keychain-held master key, AES-256-GCM envelope encryption, `vault:<id>` references, values never returned by API or rendered in HTML, redaction on all outputs, audit log.
- Consequences: Secrets cannot be "viewed", only replaced.
