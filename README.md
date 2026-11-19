# achords

Self-hosted, single-tenant multi-agent hub. One orchestrator agent plus role-scoped sub-agents,
per-agent model choice (frontier CLI, API or local), web dashboard and Telegram, quiet by default.

Status: pre-alpha (Phase 0 scaffold). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/adr](docs/adr).

## Requirements

- Node.js 22+ and pnpm (`corepack enable`)
- macOS (Apple Silicon recommended) or Linux

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
