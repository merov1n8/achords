# ADR-0028: Web UI with Vite + Preact + TypeScript

Status: Accepted (2026-11-19)

- Context: The dashboard (threads/chat, kanban, agents, vault, devices, later memory graph and usage meters) needs a lean, typed UI that the gateway can serve offline from localhost under a strict CSP.
- Decision: Preact (runtime, ~4 KB, MIT, no dependencies) with TypeScript; Vite as dev server and bundler (build-time only). JSX via Vite's built-in transform (`jsxImportSource: preact`), without `@preact/preset-vite`, which would pull in Babel. The gateway serves `apps/web/dist` with `default-src 'self'` (no inline scripts or styles), hashed assets as immutable, client-side routes falling back to `index.html`. Versions are pinned exactly and were at least two weeks old when added.
- Design (2026-11-19): tokens from the maintainer-approved samples (light pastel / dark anthracite, violet or teal accent), left sidebar tree; fonts `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` (OFL) and `lucide-preact` (ISC, tree-shaken) bundled locally; UI strings in `locales/<lang>.json`.
- Consequences: `pnpm build` is required before the gateway can serve the UI (CI builds it). Polling (2–10 s) instead of push for now; SSE can replace it later without changing the API.
