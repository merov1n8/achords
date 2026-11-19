# CLAUDE.md (project instructions for coding agents)

## Read first

1. `docs/ARCHITECTURE.md` and `docs/adr/` (accepted decisions; do not contradict them without a new ADR).
2. `.dev/CONTEXT.md` and `.dev/PHASE-1.md` if present (maintainer's private notes, gitignored).

## Rules

- Language: all code, comments, identifiers, commit messages and docs in English.
- Stack: TypeScript (strict, NodeNext, explicit `.ts` import extensions), Node 22+, pnpm workspaces, Biome, Vitest.
- Before saying "done": `pnpm lint && pnpm typecheck && pnpm test` must pass.
- Tests first for bugs (failing test, then fix). Every new package module gets tests.
- Minimal code, no speculative abstractions. Comments explain why, not what.
- Never commit secrets. Secrets are referenced as `vault:<id>` only. Never print secret values in logs, UI or HTML.
- New dependency: justify it in the PR description; prefer the standard library.
- Architectural change: add an ADR in `docs/adr/` and update `docs/ARCHITECTURE.md`.
- Update `CHANGELOG.md` (Unreleased) for user-visible changes.

## Git workflow

- `main` is protected. Work on `feature/<name>`, open a PR, CI must be green.
- Ask the maintainer before commit, push, merge, rebase, reset or branch deletion.
- Commit style: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`).

## Commands

- `pnpm install`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`
