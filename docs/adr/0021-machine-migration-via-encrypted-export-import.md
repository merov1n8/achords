# ADR-0021: Machine migration via encrypted export/import

Status: Proposed (2026-11-19)

- Context: The owner develops on a MacBook and runs production on a Mac Mini; customers will also move installs between machines. Rebuilding config, skills, memory and secrets by hand is error-prone.
- Decision: All state lives under a single `ACHORDS_HOME`. `achords export` produces one passphrase-encrypted archive; vault secrets are re-wrapped with the export key and re-wrapped with the target Keychain key on `achords import`. Subscription CLI logins, Tailscale identity and model weights are not exported. Imports start paused; export pauses the source. Ships together with the production-grade `achords init`.
- Consequences: Every new piece of state must live under `ACHORDS_HOME` and be covered by export tests. Archive format and KDF to be fixed when implemented (status then moves to Accepted).
