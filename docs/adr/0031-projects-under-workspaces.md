# ADR-0031: Projects under workspaces (client preferences and working folders)

Status: Accepted (2026-11-20)

- Context: Workspaces are business branches (`web-clients`, `studio`). Client work needs one more level: each client has its own preferences, stack and deploy rules that the owner should not repeat in every message, and existing code bases must be handed over to agents while the owner keeps working on the same files (e.g. a WordPress shop where agents develop and stage, but only the owner deploys).
- Decision:
  - A project is a folder `$ACHORDS_HOME/projects/<slug>/` with `project.yaml` (`name`, `workspace`; strict schema), `PROJECT.md` (preferences, stack, conventions, don'ts, deploy rules), `files/` (the working folder) and an optional `workflow.yaml` that replaces the workspace's workflow for its cards.
  - Files are managed in Finder only (maintainer decision): the owner copies or clones code into `files/` and works in the same folder. No web upload.
  - Threads and tasks carry a `project`. The owner sets it per thread (web chat header, Telegram `/project <slug>`); delegated tasks and their children inherit it.
  - Runs of a project task get `PROJECT.md` in the prompt. An agent whose workspace is the project's workspace also gets `files/` as its working directory and write root for that run, on top of its manifest; agents of other workspaces get the text but no folder access. This is the only way a project widens a run, and it is visible in the ADR and the run's cwd.
  - The boss sees the thread's project and its `PROJECT.md` when deciding.
  - Memory: project work is stored and recalled in its own namespace `<workspace>/<slug>`, next to the workspace and `shared`, so one client's details do not surface in another client's runs.
- Consequences: Client rules live in one file the owner edits; agents work where the owner works. Production credentials stay out of agent reach by keeping them out of the vault entirely or (later) by per-project secret scopes. Projects are created in the web UI or by hand (a folder with `project.yaml`); removing a project is a manual folder deletion.
