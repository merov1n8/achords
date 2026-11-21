# ADR-0043: Auto-update from the public main branch

Status: Accepted (2026-11-21); supersedes the signed-release part of ADR-0016 for now

- Context: achords is developed in a public repository whose `main` is protected (PRs, green CI, owner merges). Premium parts will not be features of this repository. A signing ceremony per release adds work without protecting anything that the protected branch and CI do not already protect for this owner. Manual restarts after every merge slow the owner down.

- Decision:
  - The installed service (launchd job `dev.achords.gateway`, or our systemd unit with `ACHORDS_SERVICE=1`) checks once an hour (Settings → Updates: switch, default on; "Check now").
  - It takes a newer `origin/main` only if the checkout is on `main` without local changes, the new commit is a fast-forward, and every GitHub check run on it completed successfully (public API, no token). A checkout that moved ahead of the running code (pulled by hand) counts as an update too.
  - The update is applied when no agent is running or claimed: `git merge --ff-only`, `pnpm install --frozen-lockfile`, `pnpm build`, and a self-test that loads the new gateway code. Then the gateway exits with code 75 and launchd starts the new code; the new gateway tells the owner what changed.
  - Any failing step rolls back to the commit that was running (reset, install, build) and tells the owner. If the new code fails to start, the tiny entrypoint (`main.ts`, loads the gateway lazily) rolls back before launchd restarts it.
  - Tests, CI and gateways started by hand never update.

- Consequences: Merged work goes live by itself within the hour at an idle moment, with an automatic way back. Whoever can merge to `main` controls the installs that follow it; signed releases stay in `.dev/FUTURE-IDEAS.md` for installs from forks or mirrors or a wider team.
