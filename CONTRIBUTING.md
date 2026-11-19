# Contributing

- Branches: `main` is protected; work on `feature/<short-name>` and open a PR.
- Before pushing: `pnpm lint && pnpm typecheck && pnpm test`.
- Never commit secrets. The pre-commit hook runs gitleaks; CI runs it again.
- Architectural changes need an ADR in `docs/adr/`.
- External contributions require signing the Contributor License Agreement (CLA) before merge.
  This keeps the project able to ship Apache-2.0 core alongside commercial plugins.
- Code, comments, identifiers and commit messages are in English.
