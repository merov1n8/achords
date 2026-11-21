# ADR-0042: The owner's own accounts for work without a client project

Status: Accepted (2026-11-21)

- Context: Integration sign-ins are already system-wide (one Google sign-in, one Meta token). ADR-0036 limits shared accounts per client project; as a side effect, work without a project (the owner's own business) could not use Google or Meta at all, and per-site credentials ({project}) needed a project. The owner expects integrations at the level of a service, usable across projects and outside them.

- Decision:
  - `~/.achords/accounts.yaml` holds the owner's own account lists, the same shape as a project's (`integrations: {facebook: [...], ga4: [...], wordpress: [https://…]}`), edited on Settings → Integrations ("Your own accounts").
  - Work without a client project resolves integrations against these, as a reserved pseudo-project `own`: scope targets, `{account:…}` values and `{project}` vault ids (e.g. `wordpress-user-own`). Agent runs, monitors and connection tests all follow this.
  - A client project only ever uses its own accounts; it never falls back to the owner's. `own` cannot be used as a project name.
  - Status and doctor list `own` like a project.

- Consequences: Sign-ins stay global, the per-client limits stay, and the owner's own work gets the same integrations. Nothing is shared between a client's work and the owner's own.
